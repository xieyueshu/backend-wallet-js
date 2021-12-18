const crypto = require("crypto");
const BigNumber = require("bignumber.js");

const baseUtil = require("./base_utils");
const secUtil = require("./security_utils");
const fileUtil = require("./file_utils");
const mailUtil = require("./mail_utils");
const dbUtil = require("./db_utils");
const logger = require("../../config/winston");
const sign = require("./amt_lib/sign");
const rpc = require("./amt_lib/rpc");
const AT_CONST = require("./amt_lib/constants");
const AT_ERROR = require("./amt_lib/error_codes");
const seedUtil = require("./seed_lib/seed");

const createWallet = async () => {
	logger.debug("amt_utils.createWallet - generating AMT address");
	let wallet = await seedUtil.genSeed("");
	logger.debug(`amt_utils.createWallet - response ${JSON.stringify(wallet)}`);

	// import the key into the node to watch for any changes
	logger.debug("amt_utils.createWallet - RPC call: " + AT_CONST.RPC_IMPORT);
	await rpc.call(AT_CONST.RPC_IMPORT, [wallet.address, "", false]);
	return wallet;
};

const getLastBlock = async () => {
	logger.debug("amt_utils.getLastBlock - RPC call: " + AT_CONST.RPC_BLOCK_CNT);
	let response = await rpc.call(AT_CONST.RPC_BLOCK_CNT);
	logger.debug(`amt_utils.getLastBlock - ${JSON.stringify(response)}`);
	return response.result;
};

const getBlock = async (blockNum, level = 1) => {
	logger.debug("amt_utils.getBlock - RPC call: " + AT_CONST.RPC_GET_BLOCK);
	let response = await rpc.call(AT_CONST.RPC_GET_BLOCK, [blockNum.toString(), level]);
	logger.debug(`amt_utils.getBlock - ${response.id}`);
	return response.result;
};

const validateAddress = async (address) => {
	logger.debug("amt_utils.validateaddress - RPC call: " + AT_CONST.RPC_VALIDATE);
	let response = await rpc.call(AT_CONST.RPC_VALIDATE, [address]);
	logger.debug(`amt_utils.validateaddress - ${address}: ${JSON.stringify(response.result.isvalid)}`);
	return response.result.isvalid && response.result.address === address; // check if address to skip pubkey or privkey
};

const isImportedAddress = async(address) => {
	logger.debug("amt_utils.isImportedAddress - RPC call: " + AT_CONST.RPC_LIST_ADDRESS);
	let response = await rpc.call(AT_CONST.RPC_LIST_ADDRESS, [address, true]);
	const result = response.result[0];
	logger.debug(`amt_utils.isImportedAddress - ${address}: ${!!result}`);
	return !!result; // returns true if it has been imported and false if none
}

const importAddress = async(addresses, rescan = false) => {
	logger.debug("amt_utils.isImportedAddress - RPC call: " + AT_CONST.RPC_IMPORT);
	let response = await rpc.call(AT_CONST.RPC_IMPORT, [addresses, "", rescan]);
	logger.debug(`amt_utils.isImportedAddress - ${JSON.stringify(response.result)}`);
	return response.result; 
}

const getRawTransaction = async (hash, level = 1) => {
	logger.debug("amt_utils.getRawTransaction - RPC call: " + AT_CONST.RPC_GET_TXN);
	try {
		let response = await rpc.call(AT_CONST.RPC_GET_TXN, [hash, level]);
		logger.debug(`amt_utils.getRawTransaction - ${response.id}`);
		return response.result;
	} catch (e) {
		if (e.response.body) {
			let body = JSON.parse(e.response.body);
			let error = body.error.code.toString();
			if (AT_ERROR[error] === "RPC_TX_NOT_FOUND") {
				logger.warn("amt_utils.getRawTransaction - No transaction found.");
				return null;
			}
			throw new Exception(body);
		}
		logger.error("amt_utils.getRawTransaction - An error occurred: " + e.stack);
		throw e;
	}
};

const getBalance = async (address, amtcOnly = true) => {
	logger.debug("amt_utils.getBalance - RPC call: " + AT_CONST.RPC_GET_BAL);
	let response = await rpc.call(AT_CONST.RPC_GET_BAL, [address]);
	logger.debug(`amt_utils.getBalance - ${JSON.stringify(response)}`);
	if (amtcOnly) {
		return response.result.filter(r => r.assetref === "")[0].qty;
	} else {
		return response.result;
	}
};

const checkHotWalletBalance = async (db, type = "AMT") => {
	try {
		let pendingRecords = await dbUtil.getPendingWithdrawRequest(db, type);
		let pendingAmt = pendingRecords.reduce(
			(total, record) => total + BigNumber(record.totalAmount).toNumber(), 0);
		logger.debug(`amt_utils.checkHotWalletBalance - total pending: ${pendingAmt}`);
		let hotBalance = await getBalance(process.env.AMT_HOT_WALLET, type === "AMT");
		const asset = baseUtil.getValueMem("asset");
		if(type === "AMT_A") {
			hotBalance =  hotBalance.filter(b => b.assetref === asset.assetref);
			hotBalance = hotBalance[0] ? hotBalance[0].qty : 0;
		}
		if (hotBalance < pendingAmt) {
			const coinName = type === "AMT_A" ? asset.name : "AMTC"
			mailUtil.sendWithdrawBalance(pendingAmt, hotBalance, process.env.AMT_HOT_WALLET, coinName);
		}
	} catch (err) {
		logger.debug(`amt_utils.checkHotWalletBalance - Error: ${err.stack}`);
	}
}

module.exports = {
	getRawTransaction,
	getBlock,
	getLastBlock,
	getBalance,
	checkHotWalletBalance,
	validateAddress,
	isImportedAddress,
	importAddress,
	/**
	 * Create an ambertime wallet for deposit
	 */
	createAmtWallet: async (res, db, options = { asset: false, returnPrivate: false}) => {
		let keyPair = await createWallet();
		let address = {
			type: options.asset ? "AMT_A" : "AMT",
			use: options.returnPrivate ? "S" : "D", // if we return the private key, the address's use will be for sending, not deposit
			address: keyPair.address,
			//encrypt the key before storing it in the database
			private: secUtil.encryptKey(keyPair.privateKey),
			phrase: secUtil.encryptKey(keyPair.phrase),
			public: keyPair.publicKey
		};
		logger.info("AMT address generated: " + keyPair.address);
		db.collection('address').insert(address, (err, item) => {
			if (err) {
				logger.error(err.stack);
				res.send({
					"error": "An error has occurred"
				});
			} else {
				try {
					// send a copy of the address details via email
					mailUtil.sendAddressCopy(address);
				} catch (err) {
					logger.warn("amt_utils.createAmtWallet - error on sending to mail: " + err.stack);
				}
				try {
					// append the generated address to a list of the generated addresses
					fileUtil.appendAddress(address);
				} catch (err) {
					logger.warn("amt_utils.createAmtWallet - Error on appending address to file: " + err.stack);
				}
				// remove unneeded fields before returning to the user
				delete address.use;
				delete address._id;
				if(!options.returnPrivate) {
					delete address.private;
					delete address.phrase;
				} else {
					address.private = secUtil.encryptSecret(keyPair.privateKey);
					address.phrase = secUtil.encryptSecret(keyPair.phrase);
				}
				address.sign = secUtil.sign(address.address);
				logger.info("amt_utils.createAmtWallet - Sending to client: " + JSON.stringify(address));
				res.send(address);
			}
		});
	},
	sendAmt: async (db, wallet, willAdd = true) => {
		logger.debug("amt_utils.sendAmt - Generating raw transaction...");
		let out = {};
		const type = wallet.type;
		if (wallet.multi) {
			out = wallet.inputs.reduce((obj, input) => {
				if(type === "AMT_A"){
					if (!obj[input.address]) {
						obj[input.address] = {}
						obj[input.address][wallet.asset] = 0;
					}
					obj[input.address][wallet.asset] += input.amount  
				} else {
					if (!obj[input.address]) {
						obj[input.address] = 0;
					}
					obj[input.address] += input.amount;
				}
				return obj;
			}, {});
			logger.debug(`amt_utils.sendAmt - Sending from ${wallet.fromAddress} to ${JSON.stringify(out)}`);
		} else {
			logger.debug(`amt_utils.sendAmt - Sending ${wallet.amount} from ${wallet.fromAddress} to ${wallet.toAddress}`);
			const amount = BigNumber(wallet.amount).toNumber()
			if(type === "AMT_A"){
				out[wallet.toAddress] = {};  
				out[wallet.toAddress][wallet.asset] = amount;
			} else {
				out[wallet.toAddress] = amount
			}
		}
		const data = wallet.notes ? [ Buffer.from(wallet.notes, "utf8").toString("hex") ] : [];
		let response = await rpc.call(AT_CONST.RPC_CREATE_RAW, [wallet.fromAddress, out, data]);
		let hash = response.result;
		logger.debug("amt_utils.sendAmt - Created hash: " + hash);

		logger.debug("amt_utils.sendAmt - Signing raw transaction");
		let signRes = await rpc.call(AT_CONST.RPC_SIGN_RAW, [hash, [],
			[wallet.key]
		]);
		let txn = signRes.result.hex;

		logger.debug("amt_utils.sendAmt - Sending signed transaction to node");
		let respTxn = await rpc.call(AT_CONST.RPC_SEND_TXN, [txn]);
		logger.debug(`amt_utils.sendAmt - response: ${respTxn}`);
		let transactionId = respTxn.result;
		logger.info(`amt_utils.sendAmt - Sent txn ID: ${transactionId}`);

		let template = {
			status: "P",
			coinType: wallet.type,
			txnType: wallet.use,
			sender: wallet.fromAddress,
			recepient: wallet.toAddress,
			amount: wallet.amount,
			txnHash: transactionId,
			timeStamp: 0,
			trace: wallet.trace,
			createTime: new Date()
		};

		let txnDetails = [];
		if (wallet.multi) {
			for (let i = 0; i < wallet.inputs.length; i++) {
				let input = wallet.inputs[i];
				let txn = Object.assign({}, template);
				txn.amount = input.amount;
				txn.recepient = input.address;
				txn.trace = input.trace;
				txn.index = i;
				txn.indexHash = transactionId + `[${i}]`;
				txnDetails.push(txn);
			}
		} else {
			txnDetails.push(template);
		}

		if (willAdd) {
			try {
				await db.collection("transaction").insertMany(txnDetails);
				logger.info("amt_utils.sendAmt - Inserted transaction: " + transactionId);
			} catch (err) {
				logger.error("amt_utils.sendAmt - error occurred inserting transaction into database");
			}
		}

		return txnDetails;

	},
	/**
	 * Create a withdrawal request for AMT
	 */
	createAmtWithdrawRequest: async (withdrawals, db, after) => {
		try {
			// connect to the contract
			var coinType = withdrawals.type.toUpperCase();
			logger.info("amt_utils.createAmtWithdrawRequest - Creating a AMT withdraw request");
			var hotAddress = await getAmtWithdrawWallet(coinType, db);

			let withdrawRequest = {
				hotAddress: hotAddress.address,
				transactions: []
			};

			var totalAmount = new BigNumber(0),
				totalGas = 0;

			for (let i = 0; i < withdrawals.request.length; i++) {
				let request = withdrawals.request[i];
				let amt = BigNumber(request.amount);
				let trace = request.trace || '';
				request.address = request.address.trim();
				let addr = request.address;

				// check if the amount being sent is equal to zero or negative
				if (amt.lte(BigNumber(0))) {
					logger.warn("amt_utils.createAmtWithdrawRequest - Negative or zero amounts are not allowed");
					after({
						error: "Negative or zero amounts are not allowed"
					});
					return;
				}
				let isValid = await validateAddress(addr);
				if (!isValid) {
					logger.warn("amt_utils.createAmtWithdrawRequest - Receiving address is not a valid address: " + request.address);
					after({
						error: "Address supplied is not a valid address: " + request.address
					});
					return;
				}

				let hasTrace = await dbUtil.hasSameTrace(db, trace);
				if (hasTrace) {
					logger.warn("eth_utils.createEthWithdrawRequest - Trace already exists in the database: " + trace);
					after({
						error: "Trace exists in database: " + trace
					});
					return;
				}

				let details = {
					id: crypto.randomBytes(16).toString('hex'),
					// gas: web3.toHex(gas),
					amount: amt.toString(),
					requestAddr: request.address,
					sent: false,
					trace
				};
				logger.debug(`amt_utils.createAmtWithdrawRequest - ${JSON.stringify(details)}`);

				withdrawRequest.transactions.push(details);
				totalAmount = totalAmount.plus(amt);
				// totalGas += gas;
			}

			withdrawRequest.totalAmount = totalAmount.toString();
			withdrawRequest.coinType = coinType;
			withdrawRequest.estimateGas = totalGas;
			withdrawRequest.sentAmount = false;
			withdrawRequest.createDt = new Date();
			// check if the request requires approval first
			if (withdrawals.approved) {
				logger.debug(`amt_utils.createAmtWithdrawRequest - approved withdrawal request with amount ${totalAmount}`);
				withdrawRequest.approvedStatus = "A";
			} else {
				let wdApproval = coinType === "AMT" ? process.env.WITHDRAW_AMT_APPROVAL : process.env["WITHDRAW_AMT_A_APPROVAL"];
				logger.debug(`amt_utils.createAmtWithdrawRequest - withdraw approval amount: ${wdApproval}`);
				if (wdApproval) {
					let withdrawAmt = BigNumber(totalAmount);
					let isApproved = withdrawAmt.lte(BigNumber(wdApproval));
					withdrawRequest.approvedStatus = isApproved ? "A" : "P";
				} else {
					logger.debug(`amt_utils.createAmtWithdrawRequest - no withdraw approval amount. Automatically approving`);
					withdrawRequest.approvedStatus = "A";
				}
			}
			logger.debug(`amt_utils.createAmtWithdrawRequest - ${JSON.stringify(withdrawRequest)}`);
			db.collection("withdraw_request").insert(withdrawRequest, (err, item) => {
				if (err) {
					after({
						error: "An error has occurred"
					});
					logger.error('amt_utils.createAmtWithdrawRequest - error: ' + err.stack);
				} else {
					let requestDetails = {
						requestId: item.ops[0]._id,
						address: hotAddress.address,
						// estimateGas: web3.fromWei(totalGas),
						totalAmount,
					};
					after(requestDetails);
					if (withdrawRequest.approvedStatus === "A" && process.env.WITHDRAW_BALANCE_NOTIF === "Y") {
						const asset = baseUtil.getValueMem("asset");
						const coinName = coinType === "AMT_A" ? asset.name : "AMTC";
						checkHotWalletBalance(db, coinType, coinName);
					}
					logger.info("amt_utils.createAmtWithdrawRequest - Inserted withdraw request with ID " + requestDetails.requestId);
				}
			});
		} catch (err) {
			logger.error('amt_utils.createAmtWithdrawRequest - ' + err.stack);
			after({
				error: "An error occurred while processing the request"
			});
		}
	},
	transferToCold: async (db, transfer) => {
		const minFee = parseFloat(process.env.AMT_FEE_MIN);
		if (transfer.type !== "AMT_A" && transfer.amount <= minFee) return; // don't send if the balance is not enough
		const amount = transfer.type === "AMT" ? transfer.amount - minFee : transfer.amount;
		let list = await dbUtil.getDepositList(db, "amt");
		if (!list) {
			list = [{
				address: process.env.AMT_COLD_WALLET,
				rate: 1
			}];
		}
		const transferList = list.map(item => {
			return {
				address: item.address,
				amount: (item.rate * amount)
			}
		});
		let wallet = {
			fromAddress: transfer.address,
			key: transfer.private,
			multi: true,
			inputs: transferList,
			use: "T",
			type: transfer.type,
			asset: transfer.asset || null
		};
		await module.exports.sendAmt(db, wallet);
	},
	isAmtAsset: (type) => {
		const asset = process.env.AMT_ASSET_SUPPORT === "Y" ? baseUtil.getValueMem("asset") : null;
		type = type.toUpperCase();
		return asset && 
					 (type === "AMT_A" || type === (asset.name).toUpperCase() || type === asset.assetref);
	},
	recoverAddress: seedUtil.genFromPhrase
};

/**
 * Get the amt wallet to be used for the withdraw request.
 * @param {type of wallet to be generated} type 
 * @param {db object used for performing database methods} db 
 */
const getAmtWithdrawWallet = async (type, db) => {
	var hotAddress;
	if (process.env.USES_BIND_WALLET_WD === "Y") {
		// get the wallet details from the config file if withdrawals are from a single wallet
		hotAddress = {
			address: process.env.AMT_HOT_WALLET,
			key: process.env.AMT_HOT_WALLET_SECRET,
			type
		};
		logger.debug("Using hot wallet for withdraw request " + process.env.AMT_HOT_WALLET);
	} else {
		// generate the wallet and store it into the database
		let keyPair = await createWallet();
		hotAddress = {
			address: keyPair.address,
			key: keyPair.privkey,
			type
		}

		let wallet = {
			type,
			use: "W",
			address: keyPair.address,
			private: secUtil.encryptKey(keyPair.privkey)
		};
		await db.collection("address").insert(wallet);
		logger.info("AMT address generated: " + wallet.address);
	}
	return hotAddress;
}