const axios = require("axios");
const querystring = require('querystring');

const base = require("../utils/base_utils");
const secUtil = require("./security_utils");
const logger = require("../../config/winston");

module.exports = {
	/**
	 * Calls the client to notify them of the successful transaction
	 */
	sendTransaction: async (txn, db, toUrl = null) => {
		// let signature = securityUtil.sign(txn.txnHash);
		let url = toUrl, hash = txn.txnHash;
		if(!toUrl) {
			if (txn.txnType === "D") {
				url = process.env.SUCCESS_DEPOSIT_URL;
			} else if (txn.txnType === "W") {
				txn.actualHash = hash;
				if (txn.indexHash) txn.txnHash = txn.indexHash;
				url = process.env.SUCCESS_WITHDRAW_URL;
			} else if (txn.txnType === "S") {
				url = process.env.SUCCESS_SEND_URL;
			} else { return; } // no sending of non-deposit/withdraw
			
			if(!url) return; // no url, no sending
		}
		if (txn.coinType === "AMT_A") txn.coinType = base.getValueMem("asset").name;
		if (txn.coinType === "AMTC") txn.coinType = process.env.ETH_CONTRACT_SYMBOL;
		logger.debug("http_utils.sendTransaction - " + JSON.stringify(txn));
		let rawSign = txn.sender + txn.recepient + txn.txnHash + txn.amount;
		if (process.env.MULTIPLE_COIN === 'Y') {
			rawSign += txn.coinType;
		}
		if (txn.fees) {
			rawSign += txn.fees;
		}
		txn.sign = secUtil.sign(rawSign);
		const urlList = url.split(',');
		for(const u of urlList) {
			delete txn._id;
			logger.info("http_utils.sendTransaction - Sending transaction " + txn.txnHash + " to " + u);
			try {
				const resp = await axios.post(u, querystring.stringify(txn));
				const expected = process.env.SEND_CHECKING_EXPECTED || "OK";
				logger.debug(`http_utils.sendTransaction - Response: ${JSON.stringify(resp.data)}; expected: ${expected}; checking: ${process.env.SEND_CHECKING_ENABLED}`);
				if(process.env.SEND_CHECKING_ENABLED === "Y" && JSON.stringify(resp.data) !== expected) {
					logger.warn("http_utils.sendTransaction - Transaction " + txn.txnHash + " didn't have expected response. Added to db for resending");
					saveFailed(db, txn, u);
				}
				logger.info(`http_utils.sendTransaction - Success sending to ${u}`);
			} catch (error) {
				logger.error("http_utils.sendTransaction - error sending to " + u + ": " + error.stack);
				// if the transaction hasn't been sent successfully, store it into another table and try again after a few minutes
				if (process.env.SEND_ON_ALL_ERROR === "Y" || !(error.response && error.response.status === 400)) {
					logger.warn("http_utils.sendTransaction - Transaction " + txn.txnHash + " failed to send. Added the transaction to the database for resending.");
					saveFailed(db, txn, u);
				}
			}
		}
	}
	
};

const saveFailed = (db, txn, url) => {
	txn.url = url;
	db.collection("failed_send_txn").insert(txn);
}