const fs = require("fs");
const crypto = require("crypto");

const BigNumber = require("bignumber.js");
const securityUtil = require("./security_utils");
const httpUtil = require("./http_utils");
const logger = require("../../config/winston");

module.exports = {
	/**
	 *  get the last nonce value of the transactions sent so far for an address
	 */
	getMaxNonce: async (address, db) => {
		// get the max nonce of the address
		let txn = await db.collection("transaction").find({
			sender: address
		}).sort({
			nonce: -1
		}).limit(1).toArray();
		// return -1 if there is no transaction found in the db
		return txn.length === 0 ? -1 : txn[0].nonce;
	},
	/**
	 *  Checks if there are other txns that have the same nonce
	 */
	hasSameNonce: async (address, nonce, db) => {
		// get all transactions that have the same nonce
		let txn = await db.collection("transaction").find({
			sender: address,
			nonce: nonce
		}).toArray();
		return txn.length > 1;
	},
	hasSameTrace: async (db, trace) => {
		let hasTrace = false;
		if (!trace) return false; //null or empty strings are considered unique
		// first check if the trace is in the non-failed transactions list
		let traceFoundTxn = await db.collection("transaction").find({
			"trace": trace,
			"status": {"$ne" : "X"}
		}).toArray();
		hasTrace = traceFoundTxn.length > 0;
		// next, check if the trace is in the unsent withdraw requests
		let traceFound = await db.collection("withdraw_request").find({
			"transactions.trace": trace,
			"sentAmount": false
		}).toArray();
		hasTrace = hasTrace || traceFound.length > 0;
		return hasTrace;
	},
	hasSameDepositTxid: async (db, txid) => {
		if (!txid) return false; //null or empty strings are considered unique
		let txnFound = await db.collection("transaction").find({
			txnType: "D",
			txnHash: txid
		}).toArray();
		return txnFound.length > 0;
	},
	hasPendingIncoming: async (db, address, coinType) => {
		let depositTxn = await db.collection('transaction').find({
			txnType: "T",
			status: "P",
			recepient: address
		}).toArray();
		return depositTxn.length > 0;
	},
	checkWithdrawApproval: (withdrawals, request) => {
		if (withdrawals.approved) {
      logger.debug(`checkWithdrawApproval - approved withdrawal request with amount ${request.totalAmount}`);
      return "A";
    } else {
      let wdApproval = process.env["WITHDRAW_"+request.coinType+"_APPROVAL"];
      logger.debug(`checkWithdrawApproval - withdraw approval amount: ${wdApproval}`);
      if (wdApproval) {
        return BigNumber(request.totalAmount).lte(wdApproval) ? "A" : "P";
      } else {
        logger.debug(`checkWithdrawApproval - no withdraw approval amount. Automatically approving`);
        return "A";
      }
		}
	},
	getGasPrice: async (db, coinType) => {
		let gasBase = await db.collection('base').findOne({
			name: coinType + "GasPrice"
		});
		const gasVals = gasBase.value;
		const estimateKey = process.env.BTC_FEE_ESTIMATE || "fastest";
		return gasVals[estimateKey + "Fee"];
	},
	/**
	 * Update the coin rates of the other currencies based on the USD rates
	 */
	updateCoinRates: async (db) => {
		let currRates = await db.collection('base').findOne({
			name: 'currencyRates'
		}, {
			fields: {
				_id: 0,
				name: 0,
				lastUpdated: 0
			}
		});
		let exchRates = await db.collection('base').findOne({
			name: 'exchangeRates'
		}, {
			fields: {
				USD: 1
			}
		});
		let updatedCoinRates = {};
		for (let curr in currRates) {
			if (currRates.hasOwnProperty(curr)) {
				let newRates = getRateFromUSD(exchRates.USD, currRates[curr]);
				updatedCoinRates[curr] = newRates;
			}
		}
		updatedCoinRates["lastUpdated"] = new Date().toUTCString();
		await db.collection("base").findOneAndUpdate({
			name: 'exchangeRates'
		}, {
			$set: updatedCoinRates
		});
		logger.debug("db_utils.updateCoinRates - Updated Rates: " + JSON.stringify(updatedCoinRates));
	},
	/**
	 * Retrieve address from the database. If the address is the hot wallet, we
	 * retrieve details from the config file instead.
	 */
	retrieveAddress: async (db, address, type = "ETH", use = "T") => {
		let addrRecord = {};
		if (address === process.env.ETH_HOT_WALLET) {
			addrRecord = {
				address: process.env.ETH_HOT_WALLET,
				private: process.env.ETH_HOT_WALLET_SECRET,
				type,
				use
			}
		} else if (address === process.env.AMT_HOT_WALLET) {
			addrRecord = {
				address: process.env.AMT_HOT_WALLET,
				private: process.env.AMT_HOT_WALLET_SECRET,
				type,
				use
			}
		} else if (address === process.env.BTC_HOT_WALLET) {
			addrRecord = {
				address: process.env.BTC_HOT_WALLET,
				private: process.env.BTC_HOT_WALLET_SECRET,
				type,
				use
			}
		} else if (address === process.env.EOS_HOT_WALLET) {
			addrRecord = {
				address: process.env.EOS_HOT_WALLET,
				private: process.env.EOS_HOT_WALLET_SECRET,
				type,
				use
			}
		} else {
			addrRecord = await db.collection("address").findOne({
				address: address
			});
			addrRecord.private = securityUtil.decryptKey(addrRecord.private);
		}

		logger.debug("db_utils.retreiveAddress - retrieved address: " + addrRecord.address);
		return addrRecord;
	},
	retrieveUser: async (db, username) => {
		let user = {};
		if (username) {
			user = await db.collection("user").findOne({
				username: username
			});
		} else {
			user = await db.collection("user").find({}).toArray();
		}

		return user;
	},
	retrieveUserPermissions: async (db) => {
		let permission = [];
		permission = await db.collection("permission").find().toArray();

		return permission;
	},
	getPendingWithdrawRequest: async (db, type) => {
		let pending = await db.collection("withdraw_request").find({
			coinType: type,
			sentAmount: false,
			approvedStatus: "A"
		}).toArray();
		return pending;
	},
	getPendingWithdraw: async (db, type) => {
		if (typeof type === "object"){
			type = {$in: type}
		}
		let pending = await db.collection("transaction").find({
			coinType: type,
			status: "P"
		}).toArray();
		return pending;
	},
	getDepositList: async (db, type) => {
		const depositList = await db.collection("base").find({
			name: "depositList"
		}).toArray();
		return depositList.length > 0 ? depositList[0][type.toLowerCase()] : null;
	},
	getDepositAddr: async (db, type, isDetailed = false) => {
		const bind = process.env.USES_BIND_WALLET_D === "Y";
		if (bind) {
			let coldId = type.toUpperCase() + "_COLD_WALLET";
			walletList = [process.env[coldId]];
		} else {
			// retrieve the addresses from the database
			walletList = (await db.collection('address').find({
				use: 'D',
				type: {
					$in: [type]
				}
			}).toArray()).map((w) => {
				return w.address;
			});
		}
		return walletList;
	},
	getCurrencyRate: async (db, toRate) => {
		const rates = await db.collection("base").findOne({
			name: "currencyRates"
		});
		return rates[toRate];
	},
	getBaseItemValue: async(db, name) => {
		const item = await db.collection("base").findOne({
			name
		});
		return item.value;
	},
	createAndSendTxn: async (db, txn, det = {}) => {
		let txnDetails = {
			txnType: txn.type || "D",
			coinType: txn.coin || det.coin,
			sender: txn.from,
			recepient: det.to || txn.to,
			amount: txn.amount || det.amount,
			createTime: new Date(),
			gas: txn.gas || 0,
			nonce: txn.nonce || 0,
			txnHash: txn.hash,
			status: txn.status || "L",
			timeStamp: txn.timeStamp || 0,
			blockNumber: txn.blockNumber || 0,
			trace: txn.trace || ""
		};
		if (det.rate) {
			txnDetails["RP"] = BigNumber(det.amount).times(BigNumber(det.rate)).toString();
			if (det.isMarked) {
				logger.debug("db_utils.createAndSendTxn - found marked address. Sending extra IP");
				txnDetails["FP"] = BigNumber(txnDetails["RP"]).times(BigNumber("0.1")).toString();
			}
		}
		logger.debug("db_utils.createAndSendTxn - " + JSON.stringify(txnDetails));
	
		await db.collection('transaction').insert(txnDetails);
		// send only completed transactions to the client
		if (txnDetails.status === "L") {
			httpUtil.sendTransaction(txnDetails, db);
		}
		return txnDetails;
	}
};

const getRateFromUSD = (coinRates, USDRate) => {
	let newRates = {};
	Object.keys(coinRates).forEach(function (coin) {
		newRates[coin] = coinRates[coin] * USDRate
	});
	return newRates;
}