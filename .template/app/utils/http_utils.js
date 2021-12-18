const axios = require("axios");
const querystring = require("querystring");

const base = require("../utils/base_utils");
const secUtil = require("./security_utils");
const settingUtil = require("./setting_utils");
const logger = require("../../config/winston");

module.exports = {
  /**
	 * Calls the client to notify them of the successful transaction
	 * Sep 10 2020 (danie) - retrieved urls from settings
	 */
  sendTransaction: async (txn, db, toUrl = null) => {
    let url = toUrl, hash = txn.txnHash;
    if(!toUrl) {
      const settings = await settingUtil.getEnvSettings(db);
      if (txn.txnType === "D") {
        url = settings.SUCCESS_DEPOSIT_URL;
      } else if (txn.txnType === "W") {
        txn.actualHash = hash;
        if (txn.indexHash) txn.txnHash = txn.indexHash;
        url = settings.SUCCESS_WITHDRAW_URL;
      } else if (txn.txnType === "S") {
        url = settings.SUCCESS_SEND_URL;
      } else { return; } // no sending of non-deposit/withdraw
			
      if(!url) return; // no url, no sending
    }
    if (txn.coinType === "AMT_A") txn.coinType = base.getValueMem("asset").name;
    else if (txn.coinType === "AMTC") txn.coinType = process.env.ETH_CONTRACT_SYMBOL;
    else if (txn.coinType === "TRC20" && process.env.TRX_USE_CONTRACT_SYMBOL==="Y") txn.coinType = process.env.TRX_CONTRACT_SYMBOL;
    logger.debug("http_utils.sendTransaction - " + JSON.stringify(txn));
    let rawSign = txn.sender + txn.recepient + txn.txnHash + txn.amount;
    if (process.env.MULTIPLE_COIN === "Y") {
      rawSign += txn.coinType;
    }
    if (txn.fees) {
      rawSign += txn.fees;
    }
    // include the trace in the signature for reject withdrawal
    if (txn.status === "R") {
      rawSign += txn.trace;
    }
    txn.sign = secUtil.sign(rawSign);
    const urlList = url.split(",");
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
  },

  sendRequest: async (req, db, toUrl = null) => {
    let url = toUrl;
    if (!url) {
      if(req.approvedStatus === "R") {
        url = process.env.REJECT_WITHDRAW_URL;
      } else {
        return; // no url so don't send
      }
    }
    logger.debug("http_utils.sendTransaction - " + JSON.stringify(req));
    for(const reqTxn of req.transactions) {
      reqTxn.status = "R";
      reqTxn.sender = reqTxn.txnHash = "";
      reqTxn.recepient = reqTxn.requestAddr;
      module.exports.sendTransaction(reqTxn, db, url);
    }
  },

  exportAddress: async(addressData) => {
    const exportUrl = process.env.ADDRESS_EXPORT_URL;
    if(!exportUrl || exportUrl.length === 0) return;
		
    addressData.private = secUtil.decryptKey(addressData.private);
    if(addressData.phrase) addressData.phrase = secUtil.decryptKey(addressData.phrase);

    const urlList = JSON.parse(exportUrl);
    for(const urlObj of urlList) {
      const { url, type } = urlObj;
      addressData.type = type;
      logger.info("http_utils.exportAddress - Sending address " + addressData + " to " + url);
      try {
        await axios.post(url, querystring.stringify(addressData));
        logger.info(`http_utils.exportAddress - Success sending to ${url}`);
      } catch (error) {
        logger.error("http_utils.exportAddress - error sending to " + url + ": " + error.stack);
      }
    }

  }
	
};

const saveFailed = (db, txn, url) => {
  txn.url = url;
  db.collection("failed_send_txn").insert(txn);
};