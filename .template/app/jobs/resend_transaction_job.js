const httpUtil = require("../utils/http_utils");
const logger = require("../../config/winston-job");

var isRunning = false;

async function transactionResender(db) {
  if (!isRunning) {
    isRunning = true;
    await work(db);
    isRunning = false;
  } else {
    logger.debug("Skipped transaction_resender_job run due to ongoing operation");
  }
}

/**
 * Resends transactions to the client if there have been transactions that have failed to send
 * @param {db object used to perform db operations} db 
 */
const work = async (db) => {
  logger.debug("resend_transaction_job - running");
  try {
    let failedTxns = await db.collection("failed_send_txn").find();
    failedTxns.forEach((txn) => {
      logger.debug("transaction_resender_job - Found txn for resending: " + txn.txnHash);
      let id = txn._id;
      let txnSend = txn;
      const url = txnSend.url;
      delete txnSend._id;
      delete txnSend.url;
      httpUtil.sendTransaction(txnSend, db, url);
      db.collection("failed_send_txn").deleteOne({
        _id: id
      });
    });
  } catch (err) {
    logger.error("resend_transaction_job - Error while resending transaction to client: " + err.stack);
  }
};

module.exports = {
  start: (db) => {
    let millisInterval = parseInt(process.env.RESEND_INTERVAL) * 1000;
    logger.debug("Starting up transaction_resender_job. Interval: " + millisInterval);
    setInterval(transactionResender, millisInterval, db);
  }
};