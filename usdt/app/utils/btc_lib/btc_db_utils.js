const logger = require("../../../config/winston");

module.exports = {
  filterProcessed: async (db, txnHashList, start) => {
    let deposits = (await db.collection("transaction").find({
      coinType: "BTC",
      txnType: "D"
    }).toArray()).map((txn) => txn.txnHash);
    let txnDbList = (await db.collection("btc_blocks").find({
      number: {
        $gte: start
      }
    }).toArray()).reduce((list, blk) => Object.assign(list, blk.txn), []);
    txnDbList = txnDbList.concat(deposits);
    return txnHashList.filter(hash => !txnDbList.includes(hash));
  },

  insertProcessed: async (db, txn) => {
    await db.collection("btc_blocks").update({
      number: txn.height
    }, {
      $addToSet: {
        txn: txn.txid
      }
    }, {
      upsert: true
    });
  },

  insertPendingTxn: async (db, txn) => {
    let txnDetails = {
      txnType: "D",
      coinType: "BTC",
      recepient: txn.to,
      amount: txn.amount,
      createTime: new Date(),
      txnHash: txn.txid,
      status: "P",
      timeStamp: txn.time || 0
    };
    logger.info("btc_deposit_process - inserting btc deposit with hash: " + txn.txid);

    await db.collection("transaction").insert(txnDetails);
  }
};