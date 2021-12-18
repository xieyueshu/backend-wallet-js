const Web3 = require("web3");
const BigNumber = require("bignumber.js");

const ethUtil = require("../utils/eth_utils");
const btcUtil = require("../utils/btc_utils");
const omniUtil = require("../utils/omni_utils");
const dbUtil = require("../utils/db_utils");
const amtUtil = require("../utils/amt_utils");
const secUtil = require("../utils/security_utils");
const baseUtil = require("../utils/base_utils");
const eosUtil = require("../utils/eos_utils");

const {
	passwordMiddleware,
	isLoggedIn,
	hasPermissionAction
} = require("../utils/route_utils");
const logger = require("../../config/winston");

module.exports = function (app, db) {
	/**
	 * Creates a wallet for deposit. Can be BTC or ETH wallet, depending on the parameter.
	 * If the parameter is "AMTC", the wallet returned is an ETH wallet
	 */
	app.post('/getWallet', async (req, res) => {
		if (req.body.type) {
			const requestCheck = { type: req.body.type, sign: req.body.sign };
			if(process.env.SIGNATURE_CHECK === "Y" && !secUtil.validateSignature(requestCheck)) {
				logger.warn("/getWallet - invalid signature received");
				return res.send({error: "Invalid signature", code: "INVALID_SIGNATURE"});
			} 
			const type = (req.body.type).toUpperCase();
			const chainList = process.env.CHAIN_SUPPORT;
			const returnPrivate = req.body.returnPrivate === "Y";
			if ((ethUtil.isEthToken(type) || type === "ETH") && chainList.includes("ETH"))
				ethUtil.createEthWallet(res, type, db);
			else if (type === "BTC" && chainList.includes("BTC"))
				btcUtil.createBtcWallet(res, db);
			else if (type === "OMNI" && chainList.includes("BTC"))
				btcUtil.createBtcWallet(res, db, "OMNI");
			else if (type === "AMT" && chainList.includes("AMT"))
				amtUtil.createAmtWallet(res, db, { returnPrivate });
			else if (chainList.includes("AMT") && amtUtil.isAmtAsset(type))
				amtUtil.createAmtWallet(res, db, { returnPrivate, asset: true });
			else if (await eosUtil.isCoinName(db, type) && chainList.includes("EOS"))
				eosUtil.createEosWallet(res, db);
			else {
				logger.warn("/getWallet - type not recognized " + req.body.type);
				res.send({
					error: "Type not recognized"
				});
			}
		} else {
			logger.warn("/getWallet - type cannot be blank");
			res.send({
				error: "Type cannot be blank"
			});
		}
	});

	app.post('/recoverAddress', async (req, res) => {
		const chainList = process.env.CHAIN_SUPPORT;
		const type = req.body.type;
		if (!type) {
			logger.warn("/recoverAddress - type cannot be blank");
			return res.send({
				error: "Type cannot be blank"
			});
		} else if (!req.body.phrase){
			logger.warn("/recoverAddress - type cannot be blank");
			return res.send({
				error: "Phrase cannot be blank"
			});
		}
		if (!(type === "AMT" && (chainList.includes("AMT") || amtUtil.isAmtAsset(type)))) {
			return res.send({
				error: "type not supported"
			});
		}
		try{
			const phrase = secUtil.decryptSecret(req.body.phrase);
			const address = await amtUtil.recoverAddress(phrase);
			if(!await amtUtil.isImportedAddress(address.address)) {
				await amtUtil.importAddress(address.address);
			}
			return res.send({
				address: address.address,
				private: secUtil.encryptSecret(address.privateKey),
				public: address.publicKey,
				phrase: secUtil.encryptSecret(address.phrase),
				sign: secUtil.sign(address.address)
			});
		} catch (e) {
			logger.error(`Error recovering Address: ${e.stack}`);
			return res.status(503).send({ error: "UNABLE_TO_RECOVER" });
		}
	});

	app.post('/validateAddress', async (req, res) => {
		if (!req.body.type) {
			logger.warn("/validateAddress - type cannot be blank");
			return res.send({
				error: "Type cannot be blank"
			});
		} else if (!req.body.address){
			logger.warn("/validateAddress - address cannot be blank");
			return res.send({
				error: "address cannot be blank"
			});
		} else {
			const type = (req.body.type).toUpperCase();
			const chainList = process.env.CHAIN_SUPPORT;
			let valid = false;
			if ((ethUtil.isEthToken(type) || type === "ETH") && chainList.includes("ETH")) { 
				valid = await ethUtil.isAddress(req.body.address);
			} else if (type === "BTC" && chainList.includes("BTC")) {
				return res.send({error: "NOT_IMPLEMENTED"});
			} else if (type === "AMT" && (chainList.includes("AMT") || amtUtil.isAmtAsset(type)))
				valid = await amtUtil.validateAddress(req.body.address);
			else {
				logger.warn("/validateAddress - type not recognized " + req.body.type);
				return res.send({
					error: "Type not recognized"
				});
			}
			res.send({valid});
		}
	});

	/**
	 * returns a list of all the deposit wallets generated and their amtc/eth
	 */
	app.get('/depositWalletList', (req, res) => {
		logger.info("/depositWalletList - getting generated wallets from databse...");
		db.collection("address")
			.find({
				use: "D"
			}, {
				fields: {
					address: 1,
					type: 1
				}
			})
			.toArray(async (err, addrList) => {
				if (err) {
					res.send({
						error: "An error occurred"
					});
					logger.error(err.stack);
				}
				logger.debug("/depositWalletList - Retrieved wallet list: " + JSON.stringify(addrList));
				if (addrList) {
					addrList = await getBalance(db, addrList);
					res.send(addrList);
				} else
					res.send({
						"msg": "There are no deposit wallets available"
					});
			});
	});

	/**
	 * Retrieves the hot wallet and its eth and amtc balance
	 */
	app.get('/getHotWallet', async (req, res) => {
		logger.info("/getHotWallet - retrieving hot wallet");
		try {
			let wallet = {};
			let chainList = process.env.CHAIN_SUPPORT;
			if (chainList.includes("ETH")) {
				const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
				const ethHotWallet = process.env.ETH_HOT_WALLET;
				let weiResult = await ethUtil.getBalance(web3, ethHotWallet);
				let ethBalance = BigNumber(web3.fromWei(weiResult, "ether"));
				let amtcBalance = await ethUtil.getTokenAmt(web3, ethHotWallet);
				let walletLink = process.env.ETH_WALLET_BASE_URL + ethHotWallet;
				wallet.eth = {
					address: ethHotWallet,
					eth: ethBalance,
					amtc: amtcBalance,
					walletLink
				}
			}
			if (chainList.includes("AMT")) {
				const amtHotWallet = process.env.AMT_HOT_WALLET;
				const asset = baseUtil.getValueMem('asset');
				let balances = await amtUtil.getBalance(amtHotWallet,false);
				let amtBalance = 0, assetBal = 0;
				for(bal of balances){
					if(bal.assetref === ""){
						amtBalance = bal.qty;
					}	
					if(bal.assetref === asset.assetref){
						assetBal = bal.qty;
					}	
				}
				wallet.amt = {
					address: amtHotWallet,
					amt: amtBalance,
					amt_a: assetBal
				};
			}
			if (chainList.includes("BTC")) {
				const btcHotWallet = process.env.BTC_HOT_WALLET;
				const btcBalance = await btcUtil.getBalance(btcHotWallet);
				let omniBalance = 0;
				if (process.env.BTC_OMNI_SUPPORT === "Y") {
					omniBalance = new BigNumber((await omniUtil.getBalance(btcHotWallet)).balance).toNumber();
				}
				wallet.btc = {
					address: btcHotWallet,
					btc: btcBalance,
					omni: omniBalance
				};
			}
			if (chainList.includes("EOS")) {
				const address = process.env.EOS_HOT_WALLET;
				const eosBal = await eosUtil.getBalance(db, address);
				const name = (await eosUtil.getCoinName(db)).toLowerCase();
				wallet[name] = {
					address,
				}
				wallet[name][name] = eosBal;
			}
			res.send(wallet);
		} catch (err) {
			res.send({
				error: "unable to retrieve hot wallet details"
			});
			logger.error(err.stack);
		}
	});


	app.get("/getWalletBalance", async (req, res) => {
		if (!req.query.type) return res.send({
			error: "type is required"
		});
		if (!req.query.address) return res.send({
			error: "address is required"
		});
		let {
			address,
			type
		} = req.query;
		logger.info(`/getWalletBalance - Address: ${address}, type: ${type}`);
		type = type.toUpperCase();
		const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
		try {
			let bal = 0;
			let chainList = process.env.CHAIN_SUPPORT;
			if (ethUtil.isEthToken(type) && chainList.includes("ETH")) {
				bal = await ethUtil.getTokenAmt(web3, address);
			} else if (type === "ETH" && chainList.includes("ETH")) {
				let weiResult = await ethUtil.getBalance(web3, address);
				bal = BigNumber(web3.fromWei(weiResult, "ether"));
			} else if (type === "AMT" && chainList.includes("AMT")) {
				bal = await amtUtil.getBalance(address);
			} else if (await eosUtil.isCoinName(db, type) && chainList.includes("EOS")) {
				bal = await eosUtil.getBalance(db, address);
			} else if (amtUtil.isAmtAsset(type) && chainList.includes("AMT")) {
				bal = await amtUtil.getBalance(address, false);
				const amtAsset = baseUtil.getValueMem("asset");
				bal = bal.filter(b => b.assetref === amtAsset.assetref)
				bal = bal.length === 0 ? 0 : bal[0].qty;
			} else {
				return res.send({
					error: "type is not supported"
				});
			}
			logger.debug("/getWalletBalance - Balance: " + bal);
			res.send({
				balance: bal
			});
		} catch (err) {
			logger.error(`/getWalletBalance - error: ${err.stack}`);
			res.status(500).send({
				error: "unable to retrieve balance",
				message: err.message
			});
		}
	});

	/**
	 * Adds a marked address to the list.
	 */
	app.post("/addMarkedAddress", [isLoggedIn, hasPermissionAction, passwordMiddleware], async (req, res) => {
		logger.info("/addMarkedAddress - Received marked address");
		let isMatch = await secUtil.passwordMatch(db, "markedPass", req.body.password);
		if (!isMatch) {
			logger.warn("/addMarkedAddress - password doesn't match");
			res.send({
				error: "Wrong Password"
			});
			return;
		}

		let body = req.body;
		delete body.password;
		logger.debug("/addMarkedAddress - Sent data: " + JSON.stringify(body));
		if (!body.address) {
			logger.warn("/addMarkedAddress - address is blank");
			res.send({
				error: "Address must be provided"
			});
			return;
		} else if (!ethUtil.isAddress(body.address)) {
			logger.warn("/addMarkedAddress - address isn't valid");
			res.send({
				error: "Address is not a valid Ethereum address"
			});
			return;
		}
		try {
			await db.collection("marked_address").insert({
				address: body.address
			});
			let addr = await db.collection("marked_address").find({}, {
				fields: {
					_id: 0
				}
			}).toArray();
			logger.debug("/addMarkedAddress - marked address inserted");
			res.send({
				status: "1",
				result: addr
			});
		} catch (err) {
			logger.error("/addMarkedAddress - Error while adding address " + err.stack);
			if (err.code === 11000) {
				res.send({
					error: "Duplicate address"
				});
			} else {
				res.send({
					error: "Error occurred while adding address"
				});
			}
		}
	});

	/**
	 * Removes a marked address from the list.
	 */
	app.post("/removeMarkedAddress", [isLoggedIn, hasPermissionAction, passwordMiddleware], async (req, res) => {
		logger.info("/removeMarkedAddress - Received marked address(es): " + req.body.data);
		let isMatch = await secUtil.passwordMatch(db, "markedPass", req.body.password);
		if (!isMatch) {
			logger.warn("/removeMarkedAddress - password doesn't match");
			res.send({
				error: "Wrong Password"
			});
			return;
		}

		let body = req.body;
		delete body.password;
		logger.debug("/removeMarkedAddress - Sent data: " + JSON.stringify(body));
		try {
			let num = await db.collection("marked_address").remove({
				'address': {
					'$in': body.data
				}
			});
			let addr = await db.collection("marked_address").find({}, {
				fields: {
					_id: 0
				}
			}).toArray();
			logger.debug("/removeMarkedAddress - marked address deleted");
			res.send({
				status: "1",
				result: addr
			});
		} catch (err) {
			logger.error("/removeMarkedAddress - Error while deleting address " + err.stack);
			res.send({
				error: "Error occurred while deleting address"
			});
		}
	});

};

const getBalance = async (db, addrList) => {
	// make an object with the address as the key for easy retrieval
	let listWithBal = addrList.reduce((obj, item) => (obj[item.address] = {
		type: item.type,
		bal: 0
	}, obj), {});
	let txnList = await db.collection("transaction").find({
		txnType: {
			$in: ["D", "T"]
		}
	}).toArray();
	txnList.forEach((txn) => {
		if (txn.txnType === "D") {
			listWithBal[txn.recepient].bal += parseFloat(txn.amount);
		} else {
			if (txn.coinType === "AMTC") {
				listWithBal[txn.sender].bal -= ethUtil.getAMTCAmount(txn.amount).toNumber();
			} else if (txn.coinType === "ETH" && txn.sender !== process.env.ETH_HOT_WALLET) {
				listWithBal[txn.sender].bal -= parseFloat(txn.amount);
			}
		}
	});
	// change the object back into an array
	listWithBal = Object.keys(listWithBal).map(addr => {
		return {
			address: addr,
			type: listWithBal[addr].type,
			bal: listWithBal[addr].bal
		};
	});
	return listWithBal;
}