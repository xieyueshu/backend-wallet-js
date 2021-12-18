const fs = require("fs");
const crypto = require("crypto");

const ethereumw = require('ethereumjs-wallet');
const EthereumTx = require('ethereumjs-tx');
const Web3 = require("web3");
const axios = require("axios");
const BigNumber = require("bignumber.js");

const secUtil = require("./security_utils");
const mailUtil = require("./mail_utils");
const fileUtil = require("./file_utils");
const logger = require("../../config/winston");
const dbUtil = require("./db_utils");
const ltkUtil = require("./ltk_utils");

const web3Lib = require("./eth_lib/web3_lib");


const DEFAULT_CONTRACT_DECIMAL = process.env.ETH_CONTRACT_DECIMAL || 8;

// sleep function
const sleep = (ms) => {
	return new Promise(resolve => setTimeout(resolve, ms));
};


const getAMTCAmount = (amount, decimals = DEFAULT_CONTRACT_DECIMAL) => {
	return BigNumber(amount).div(BigNumber(BigNumber(10).pow(decimals)));
};

const getRawAmount = (amount, decimals = DEFAULT_CONTRACT_DECIMAL) => {
	return BigNumber(amount).times(BigNumber(10).pow(decimals));
};

/**
 * Get average gas stored in the system. Retrieve from the web if there is none.
 */
const getAverageGasPrice = async (db) => {
	logger.debug("eth_utils.getAverageGasPrice - Getting gas price..");
	let priceRec = await db.collection("base").findOne({
		name: "ethGasPrice"
	});
	let price = priceRec.value;
	if (!price) {
		logger.warn("eth_utils.getAverageGasPrice - gas price not found in system");
		try {
			logger.debug("eth_utils.getAverageGasPrice - retrieving gas price from ethgasstation");
			let response = await axios.get('https://ethgasstation.info/json/ethgasAPI.json', {
				timeout: 15000
			});
			price = response.data.average / 10;
		} catch (err) {
			logger.error("getAverageGasPrice - error : " + err);
			price = 1;
		}
		await db.collection("base").updateOne({
			name: "ethGasPrice"
		}, {
			$set: {
				value: price
			}
		}, {
			upsert: true
		});
	}
	return price;
}

module.exports = {
	/**
	 * Sends tokens from an address to another 
	 * using the supplied contract
	 */
	sendEther: async (db, wallet, callback, willAdd = true) => {
		// if LTK support has been enabled, use the ltk sending method instead
		if(process.env.ETH_LTK_SUPPORT === "Y") {
			return ltkUtil.sendLtk(db, wallet, callback, willAdd);
		}
		if (wallet.toAddress.length === 0) {
			logger.info("No receiving address supplied; unable to proceed");
			throw new Error("No receiving address supplied");
		}
		await sleep(250); // wait 250ms so that there are only 5 transactions/sec
		logger.debug("eth_utils.sendEther - Sleep for 200 ms");
		logger.info(`eth_utils.sendEther - Transferring ${wallet.amount} from ${wallet.fromAddress} to ${wallet.toAddress}`);
		const amountToSend = wallet.amount;
		logger.debug("eth_utils.sendEther - amount: " + amountToSend);
		const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));

		var data, value, to;
		// check if the type of transaction will be AMTC or ETH
		if (wallet.type === "AMTC") {
			logger.info("eth_utils.sendEther - Creating an AMTC transaction");
			// connect to the contract
			var abiArray = JSON.parse(fs.readFileSync('resources/contract.json', 'utf-8'));
			var contract = web3.eth.contract(abiArray).at(process.env.ETH_CONTRACT_ADDRESS);
			// transform the amount into the amount of tokens
			const contractAmt = getRawAmount(amountToSend, contract.decimals()).toNumber();
			// create the transfer data using the contract
			data = contract.transfer.getData(wallet.toAddress, contractAmt, {
				from: wallet.fromAddress
			});
			value = "0x0";
			to = process.env.ETH_CONTRACT_ADDRESS
		} else {
			logger.info("eth_utils.sendEther - Creating an ETH transaction");
			data = "0x0";
			value = web3.toHex(web3.toWei(amountToSend, 'ether'));
			to = wallet.toAddress;
		}

		let nonce;
		// if the nonce has been provided, we use it
		// otherwise, get the largest nonce 
		if (wallet.nonce) {
			nonce = wallet.nonce;
		} else {
			let dbNonce = await dbUtil.getMaxNonce(wallet.fromAddress, db);
			logger.debug("eth_utils.sendEther - DB nonce : " + dbNonce);
			let webNonce = await web3Lib.getTxnCnt(web3, wallet.fromAddress);
			logger.debug("eth_utils.sendEther - Web nonce: " + webNonce);

			if (dbNonce >= webNonce) {
				nonce = dbNonce + 1;
			} else {
				nonce = webNonce;
			}
		}
		logger.debug("eth_utils.sendEther - Transaction nonce: " + nonce);

		// estimate a gas limit and multiply it by a multiplier (just to be safe)
		let gasLimit = web3.toHex(parseInt(process.env.ETH_GAS_AMOUNT) * parseFloat(process.env.ETH_GAS_LIMIT_MULTIPLIER));
		// get the average gas price and multiply it by a multiplier to ensure a faster transaction
		let ave;
		if (wallet.gas) {
			ave = wallet.gas;
		} else {
			ave = await getAverageGasPrice(db);
		}
		var price = web3.toHex((ave * parseFloat(process.env.ETH_GAS_PRICE_MULTIPLIER) * 1000000000).toFixed(0));

		logger.debug("eth_utils.sendEther - gas: " + web3.toDecimal(gasLimit));
		logger.debug("eth_utils.sendEther - price: " + web3.toDecimal(price));

		let details = {
			to,
			value,
			gasPrice: price,
			gas: gasLimit,
			nonce: nonce,
			data,
			chainId: web3.toHex(process.env.ETH_CHAIN_ID)
		};
		logger.debug("eth_utils.sendEther - " + JSON.stringify(details));

		// create, sign, and send the transaction
		const transaction = new EthereumTx(details);
		transaction.sign(Buffer.from(wallet.key.substring(2), 'hex'));
		const serializedTransaction = transaction.serialize();
		const transactionId = await web3Lib.sendRawTransaction(web3, '0x' + serializedTransaction.toString('hex'));

		logger.info("eth_utils.sendEther - Transaction sent: " + transactionId);
		// we build the transaction details to be stored in the database
		let txnDetails = {
			status: "P",
			coinType: wallet.type,
			txnType: wallet.use,
			sender: wallet.fromAddress,
			recepient: wallet.toAddress,
			amount: amountToSend,
			txnHash: transactionId,
			createTime: new Date(),
			timeStamp: 0,
			trace: wallet.trace,
			nonce
		};

		if (willAdd) {
			try {
				await db.collection("transaction").insert(txnDetails);
				logger.info("eth_utils.sendEther - Inserted transaction: " + transactionId);
			} catch (err) {
				logger.error("eth_utils.sendEther - error occurred inserting transaction into database");
			}
		}

		if (callback) {
			try {
				callback(txnDetails);
			} catch (err) {
				logger.error("eth_utils.sendEther - error occurred during callback");
			}
		}

		return txnDetails;
	},
	/**
	 * Get the amount of tokens an address holds
	 */
	getTokenAmt: (web3, address) => {
		let tknAddress = (address).substring(2);
		// hash of the "retrieve balance" for tokens
		let contractData = ('0x70a08231000000000000000000000000' + tknAddress);
		return new Promise((resolve, reject)  => {
			web3.eth.call({
				to: process.env.ETH_CONTRACT_ADDRESS,
				data: contractData
			}, (err, tknResult) => {
				if(err) reject(err);
				let tknAmt = getAMTCAmount(parseInt(tknResult, 16));
				logger.debug("eth_utils.getTokenAmt - " + tknAddress + " has " + tknAmt + " tokens");
				resolve(tknAmt);
			});
		});
	},
	getAverageGasPrice,
	/**
	 * Create an ethereum wallet for deposit
	 */
	createEthWallet: (res, type, db) => {
		let keyPair = ethereumw.generate();
		let walletType = module.exports.isEthToken(type) ? "AMTC" : type;
		let address = {
			type: walletType,
			use: "D",
			address: keyPair.getAddressString(),
			//encrypt the key before storing it in the database
			private: secUtil.encryptKey(keyPair.getPrivateKeyString())
		};
		logger.info(type + " address generated: " + keyPair.getAddressString());

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
					logger.warn("eth_utils.createEthWallet - error on sending to mail: " + err.stack);
				}
				try {
					// append the generated address to a list of the generated addresses
					fileUtil.appendAddress(address);
				} catch (err) {
					logger.warn("eth_utils.createEthWallet - Error on appending address to file: " + err.stack);
				}
				// remove unneeded fields before returning to the user
				delete address.use;
				delete address.private;
				delete address._id;
				address.type = address.type === "AMTC" ? process.env.ETH_CONTRACT_SYMBOL : type;
				address.sign = secUtil.sign(address.address);
				logger.info("eth_utils.createEthWallet - Sending to client: " + JSON.stringify(address));
				res.send(address);
			}
		});
	},
	/**
	 * Create a withdrawal request for Eth or AMTC
	 */
	createEthWithdrawRequest: async (withdrawals, db, after) => {
		try {
			// connect to the contract
			const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
			var coinType = module.exports.isEthToken(withdrawals.type) ? "AMTC" : withdrawals.type.toUpperCase();
			logger.info("eth_utils.createEthWithdrawRequest - Creating a " + coinType + " withdraw request");
			var hotAddress = await getEthWithdrawWallet(coinType, db);

			let withdrawRequest = {
				hotAddress: hotAddress.address,
				transactions: []
			};

			var totalGas = 0,
				totalAmount = new BigNumber(0);
			let gasLimit = parseInt(process.env.ETH_GAS_AMOUNT) * parseFloat(process.env.ETH_GAS_LIMIT_MULTIPLIER);
			let avePrice = await module.exports.getAverageGasPrice(db);
			let price = avePrice * 1000000000 * parseFloat(process.env.ETH_GAS_PRICE_MULTIPLIER);
			let gas = price * gasLimit;
			logger.debug("Gas: " + gas);

			for (let i = 0; i < withdrawals.request.length; i++) {
				let request = withdrawals.request[i];
				let trace = request.trace || '';
				let amt = BigNumber(request.amount);
				request.address = request.address.trim();
				let addr = "0x" + request.address.substring(2).toUpperCase();
				// check if the amount being sent is equal to zero or negative
				if (amt.lte(BigNumber(0))) {
					logger.warn("eth_utils.createEthWithdrawRequest - Negative or zero amounts are not allowed");
					after({
						error: "Negative or zero amounts are not allowed"
					});
					return;
				}
				if (!web3.isAddress(addr)) {
					logger.warn("eth_utils.createEthWithdrawRequest - Receiving address is not a valid address: " + request.address);
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
				// compute gas based on amount
				if(process.env.ETH_LTK_SUPPORT === "Y") {
					gas = ltkUtil.calculateFee(web3.toWei(request.amount));
					gas = gas.toNumber();
				}

				let details = {
					id: crypto.randomBytes(16).toString('hex'),
					gas: web3.toHex(gas),
					amount: amt.toString(),
					requestAddr: request.address,
					sent: false,
					trace
				};
				logger.debug(`eth_utils.createEthWithdrawRequest - ${JSON.stringify(details)}`);

				withdrawRequest.transactions.push(details);
				totalAmount = totalAmount.plus(amt);
				totalGas += gas;
			}

			withdrawRequest.totalAmount = totalAmount.toString();
			withdrawRequest.coinType = coinType;
			withdrawRequest.estimateGas = totalGas;
			withdrawRequest.sentAmount = false;
			withdrawRequest.createDt = new Date();
			// check if the request requires approval first
			if (withdrawals.approved) {
				logger.debug(`eth_utils.createEthWithdrawRequest - approved withdrawal request with amount ${totalAmount}`);
				withdrawRequest.approvedStatus = "A";
			} else {
				let wdApproval = coinType === "AMTC" ? process.env.WITHDRAW_AMTC_APPROVAL : process.env.WITHDRAW_ETH_APPROVAL;
				logger.debug(`eth_utils.createEthWithdrawRequest - withdraw approval amount: ${wdApproval}`);
				if (wdApproval) {
					let withdrawAmt = BigNumber(totalAmount);
					let isApproved = withdrawAmt.lte(BigNumber(wdApproval));
					withdrawRequest.approvedStatus = isApproved ? "A" : "P";
				} else {
					logger.debug(`eth_utils.createEthWithdrawRequest - no withdraw approval amount. Automatically approving`);
					withdrawRequest.approvedStatus = "A";
				}
			}
			logger.debug(`eth_utils.createEthWithdrawRequest - ${JSON.stringify(withdrawRequest)}`);
			db.collection("withdraw_request").insert(withdrawRequest, (err, item) => {
				if (err) {
					after({
						error: "An error has occurred"
					});
					logger.error('eth_utils.createEthWithdrawRequest - error: ' + err.stack);
				} else {
					let totAmt = totalAmount;
					let requestDetails = {
						requestId: item.ops[0]._id,
						address: hotAddress.address,
						estimateGas: process.env.ETH_LTK_SUPPORT === "Y" ? ltkUtil.gasToLianke(totalGas) : web3.fromWei(totalGas),
						totalAmount: totAmt,
					};

					after(requestDetails);
					logger.info("eth_utils.createEthWithdrawRequest - Inserted withdraw request with ID " + requestDetails.requestId);
				}
			});
		} catch (err) {
			logger.error('eth_utils.createEthWithdrawRequest - ' + err.stack);
			after({
				error: "An error occurred while processing the request"
			});
		}
	},
	isAddress: (address) => {
		const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
		return web3.isAddress(address);
	},
	transferToColdEth: async (db, transfer) => {
 		const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
		const minFee = parseFloat(process.env.ETH_HOT_GAS_MIN);
		var amount = transfer.amount - minFee;
		if (process.env.ETH_LTK_SUPPORT=='Y'){
			amount = new BigNumber(transfer.amount).minus(ltkUtil.gasToLianke(ltkUtil.calculateFee(web3.toWei(transfer.amount,'ether'))));
		}
		if (amount <= 0) {
			logger.debug(`Not enough balance in hot wallet ${transfer.address} for transfer`);
			return;
		}
		let list = await dbUtil.getDepositList(db, "eth");
		if (!list) {
			list = [{
				address: process.env.ETH_COLD_ETH_WALLET,
				rate: 1
			}];
		}
		let wallet = {
			fromAddress: transfer.address,
			key: transfer.private,
			use: "T",
			type: "ETH"
		};
		for (let i = 0; i < list.length; i++) {
			let item = list[i];
			wallet.toAddress = item.address;
			wallet.amount = amount * item.rate;
			await module.exports.sendEther(db, wallet);
		}
		return true;
	},
	transferToColdAmtc: async (addr, db, web3, amount = null) => {
		let bal = (await module.exports.getTokenAmt(web3, addr.address)).toNumber();
		let tokens = (amount && amount <= bal) ? amount : bal;
		const tokenMin = new BigNumber(process.env.ETH_GAS_AMTC_MIN || "0");
		const hasEnoughTokens = tokenMin.gt(0) ? new BigNumber(tokens).gte(tokenMin) : new BigNumber(tokens).gt(tokenMin);

		// get the ETH balance 
		let weiResult = await web3Lib.getBalance(web3, addr.address);
		let ethBalance = BigNumber(web3.fromWei(weiResult, "ether"));
		const hasEnoughGas = ethBalance.gte(BigNumber(process.env.ETH_HOT_GAS_MIN));
		if (hasEnoughTokens && hasEnoughGas) {
			logger.debug("eth_utils.transferToColdAmtc - There is enough ETH and tokens to make a transfer from " + addr.address);
			logger.debug("eth_utils.transferToColdAmtc - " + addr.address + " has " + ethBalance.toString() + " ETH");
			logger.debug("eth_utils.transferToColdAmtc - Found " + tokens + " tokens in the address " + addr.address);
			let wallet = {
				fromAddress: addr.address,
				toAddress: process.env.ETH_COLD_AMTC_WALLET,
				key: addr.private,
				amount: tokens,
				use: "T",
				type: addr.type
			};
			try {
				await module.exports.sendEther(db, wallet);
				return true;
			} catch (err) {
				logger.error("eth_utils.transferToColdAmtc send error: " + err.stack);
			}
		} else if (hasEnoughTokens && ethBalance.lt(BigNumber(process.env.ETH_HOT_GAS_MIN))) {
			let depositTxn = await db.collection('transaction').find({
				txnType: "T",
				status: "P",
				coinType: "ETH",
				recepient: addr.address
			}).toArray();
			// check if the address has a pending eth transfer and skip
			if(depositTxn.length > 0) return false;

			// get the amount that will be transferred
			const gasAmtTransfer = BigNumber(process.env.ETH_HOT_GAS_TRANSFER);
			logger.debug(`transferring gas to ${addr.address}`);
			let wallet = {
				fromAddress: process.env.ETH_HOT_WALLET,
				toAddress: addr.address,
				key: process.env.ETH_HOT_WALLET_SECRET,
				amount: gasAmtTransfer.toString(),
				use: "T",
				type: "ETH"
			};
			try {
				logger.debug("wallet_processess.sendGasToAmtcDeposit - Transferring " + gasAmtTransfer.toString() + " ETH to " + addr.address);
				// send eth to the amtc wallet
				await module.exports.sendEther(db, wallet);
				return false;
			} catch (err) {
				logger.error(err.stack);
			}
		}
		return false;
	},
	isEthToken: (type) => {
		const id = type.toUpperCase();
		return id === "AMTC" || id === process.env.ETH_CONTRACT_SYMBOL;
	},
	getAMTCAmount,
	getBalance: web3Lib.getBalance,
	getBlock: web3Lib.getBlock,
	getLatestBlock: web3Lib.getLatestBlock,
	getReceipt: web3Lib.getReceipt,
}


/**
 * Get the eth wallet to be used for the withdraw request.
 * @param {type of wallet to be generated} type 
 * @param {db object used for performing database methods} db 
 */
const getEthWithdrawWallet = async (type, db) => {
	var hotAddress;
	if (process.env.USES_BIND_WALLET_WD === "Y") {
		// get the wallet details from the config file if withdrawals are from a single wallet
		hotAddress = {
			address: process.env.ETH_HOT_WALLET,
			key: process.env.ETH_HOT_WALLET_SECRET,
			type
		};
		logger.debug("Using hot wallet for withdraw request " + process.env.ETH_HOT_WALLET);
	} else {
		// generate the wallet and store it into the database
		let keyPair = ethereumw.generate();
		hotAddress = {
			address: keyPair.getAddressString(),
			key: keyPair.getPrivateKeyString(),
			type
		}

		let wallet = {
			type,
			use: "W",
			address: keyPair.getAddressString(),
			private: secUtil.encryptKey(keyPair.getPrivateKeyString())
		};
		await db.collection("address").insert(wallet);
		logger.info("ETH address generated: " + wallet.address);
	}
	return hotAddress;
}
