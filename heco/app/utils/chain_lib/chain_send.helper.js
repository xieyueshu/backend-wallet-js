const logger = require("../../../config/winston-job.js");

module.exports = {
  getTransactionDetails (wallet, txnHash, nonce = null) {
    return {
      nonce, txnHash,
      status: "P",
      coinType: wallet.type,
      txnType: wallet.use,
      sender: wallet.senderAddress || wallet.fromAddress,
      from: wallet.fromAddress,
      recepient: wallet.toAddress,
      trace: wallet.trace,
      amount: wallet.amount,
      createTime: new Date(),
      timeStamp: 0,
    };
  },

  async insertSendTransaction(db, txnDetails) {
    try {
      await db.collection("transaction").insertOne(txnDetails);
      logger.info("sendHelper - Inserted transaction: " + txnDetails.txnHash);
    } catch (err) {
      logger.error("sendHelper - error occurred inserting transaction into database");
    }
  },
};