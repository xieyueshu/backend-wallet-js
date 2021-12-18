const logger = require("../../../config/winston");

module.exports = {
  isExisting: async (db, txnId) => {
    let dbTxn = await db.collection("czdt_transfer").find({
      txnId
    }).toArray();
    return dbTxn.length > 0;
  },
  insertTransfer: async (db, czdtData) => {
    czdtData.createTime = parseInt(new Date().getTime() / 1000);
    await db.collection("czdt_transfer").insert(czdtData);

    logger.info(`inserted transfer with txhash: ${czdtData.txnId}`);
  }
};