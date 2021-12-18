const logger = require("../../config/winston");

const amtUtil = require("../utils/amt_utils");

module.exports = function(app, db) {
	/**
	 * Retrieves all deposit records
	 */
	app.get("/getDeposits", async (req, res) => {
    logger.info("/getDeposit - GET deposits");
    logger.debug(JSON.stringify(req.query));
    try{
      let afterTime = parseInt(req.query.after) || 0;
      let coinType = req.query.coinType ? req.query.coinType.toUpperCase() : "AMTC";
      if(amtUtil.isAmtAsset(coinType)){
				coinType = "AMT_A";
			}
      let query = {txnType: "D", status: "L", coinType, timeStamp: {$gte:afterTime}};
      let deposits = await db.collection("transaction").find(query).toArray();
      deposits = deposits.map((deposit) => {deposit.timeStamp = deposit.timeStamp * 1000; return deposit;});
      res.send(deposits);
    } catch (err){
      logger.error("/getDeposit - error: " + err.stack);
      res.send({error: "Server error"});
    }
	});

}