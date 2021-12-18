const logger = require("../../config/winston");

const dbUtil = require("../utils/czdt_lib/czdt_db");
const signUtil = require("../utils/czdt_lib/czdt_sign");
const rateUtil = require("../utils/czdt_lib/czdt_rate");
const httpUtil = require("../utils/http_utils");

module.exports = function (app, db) {
  app.post("/receiveczdt", async (req, res) => {
    let data = {
      address: req.body.address,
      txnId: req.body.txnId,
      amount: req.body.amount,
      apiKey: req.body.apiKey,
      sign: req.body.signature,
    };
    if (!signUtil.verify(data)) {
      logger.debug("signature not valid for request " + data.txnId);
      return res.send({
        error: "INVALID_SIGNATURE"
      });
    }
    if (await dbUtil.isExisting(db, data.txnId)) {
      logger.debug(`${data.txnId} already exists in the database`);
      return res.send({
        error: "EXISTING_TRANSACTION"
      });
    }
    data.rate = await rateUtil.getRate(db);
    if (data.rate === -1) {
      return res.send({
        error: "RETRIEVE_RATE_FAIL"
      });
    }
    data = Object.assign(data, rateUtil.getRewards(data));
    try {
      await dbUtil.insertTransfer(db, data);
      await sendTransfer(db, data);
    } catch (e) {
      logger.error("error sending: " + e.stack);
      return res.status(500).send({
        error: "SERVER_ERROR"
      });
    }
    res.send({
      success: 1
    });
  });

  app.get("/get-czdt-transfers", async (req, res) => {
    try {
      let transfers = await db.collection("czdt_transfer").find().toArray();
      res.send({
        success: 1,
        data: transfers
      });
    } catch (e) {
      logger.error("/get-czdt-transfers - error while retrieving transfers " + e.stack);
      return res.send({
        success: 0,
        error: "RETIEVE_FAIL"
      });
    }
  });
};

const sendTransfer = (db, czdtData) => {
  let txnDetails = {
    txnType: "D",
    coinType: "CZDT",
    sender: "EXCZC",
    recepient: czdtData.address,
    amount: czdtData.amount,
    createTime: new Date(),
    gas: 0,
    nonce: 0,
    txnHash: czdtData.txnId,
    status: "L",
    timeStamp: new Date().getTime(),
    RP: czdtData.RP,
    AP: czdtData.AP
  };
  // send the transaction to the client
  httpUtil.sendTransaction(txnDetails, db);
};