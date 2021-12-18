const logger = require("../../config/winston");

const dbUtil = require("../utils/db_utils");
const secUtil = require("../utils/security_utils");
const {passwordMiddleware, isLoggedIn, hasPermissionAction} = require("../utils/route_utils");

module.exports = function(app, db) {
  /**
   * Updates the conversion rate of ETH, BTC, and AMTC to USDT. Redirects back to the route `/updateRate`.
   */
  app.post("/setConversionRate", [isLoggedIn, hasPermissionAction, passwordMiddleware], async (req, res) => {
    logger.info("/setConversionRate - Setting conversion rates");
		
    let isMatch = await secUtil.passwordMatch(db, "updatePass", req.body.password);
    if(!isMatch){
      logger.warn("/setConversionRate - password doesn't match");
      res.send({error:"Wrong Password"});
      return;
    }
		
    let body = req.body;
    delete body.password;
    logger.debug("/setConversionRate - Sent data: " + JSON.stringify(body));
    let newRates  = {};
    let currency = body.currency;
    if(!currency){
      logger.warn("/setConversionRate - currency is required");
      res.send({error:"Currency is required"});
      return;
    }
    currency = currency.trim().toUpperCase();
    newRates[currency] = {};
    if(body.amtcRate)	newRates[currency]["amtc"] = parseFloat(body.amtcRate);
    if(body.ethRate)	newRates[currency]["eth"] = parseFloat(body.ethRate);
    if(body.btcRate)	newRates[currency]["btc"] = parseFloat(body.btcRate);
	
    newRates["lastUpdated"] = new Date().toUTCString();
    try {
      const result = await db.collection("base").findOneAndUpdate({name:"exchangeRates"}, {$set:newRates}, {returnOriginal:false});
      if(currency === "USD"){
        try{
          await dbUtil.updateCoinRates(db);
        } catch (err){
          logger.error("/setConversionRate - Error while setting rates "+ err.stack);
          return res.status(500).send({error: "Error updating other rates"});
        }
      }
      logger.debug("/setConversionRate - Rates updated: " + JSON.stringify(result));
      return res.send({status: "1", result: result.value});
    } catch(err) {
      logger.error("Error while setting rates "+ err.stack);
      return res.status(500).send("Error");
    }
  });
	
  /**
   * Gets the conversion rate of the type of coin 
   */
  app.get("/api/getConversionRate", (req, res) => {
    let type = req.query.type;
    let format = req.query.f;
    let callback = req.query.callback;
    let currency = req.query.currency;
    if(type){
      type = type.toLowerCase();
      db.collection("base").findOne({name: "exchangeRates"}, (err, result) => {
        if(err){
          logger.error("/api/getConversionRate - " + err.stack);
          res.send({error: err});
        }
        let rate;
        // we get the currency passed in the parameters or if there's none, we use the default currency
        if(!currency){
          currency = process.env.DEFAULT_CURRENCY;
        }
        currency = currency.toUpperCase();
        if(result[currency]){
          rate = result[currency][type];
        } else {
          logger.warn("/api/getConversionRate - currency not supported");
          res.send({error:"currency not supported: " + currency});
        }
        if(rate){
          logger.debug("/api/getConversionRate - Conversion Rate ("+type+"): " + rate);
          if(format && format === "jsonp"){
            logger.debug("/api/getConversionRate - Conversion Rate: jsonp format required");
            res.setHeader("content-type", "text/javascript");
            if(!callback || callback.length === 0){
              res.send(type+"rate={value:"+rate+"};");
            } else {
              // with callback
              res.send(callback+"({value:"+rate+"});");
            }
          } else {
            res.send({value: rate});
          }
        } else {
          logger.warn("/api/getConversionRate - type not supported");
          res.send({error:"type not supported"});
        }
      });
    } else {
      logger.warn("/api/getConversionRate - type cannot be blank");
      res.send({error: "Type cannot be blank"});
    }
  });

  /**
	 * Retrieves the average of conversion rates over the past 24 hours
	 */
  app.get("/api/getConversionSummary",  async (req, res) => {
    logger.info("/api/getConversionSummary - retrieving conversion data");
    try{
      let summary = await db.collection("rateSummary").find({},{fields:{count:0, sum:0, _id:0}}).sort({time:-1}).limit(24).toArray();
      res.send({data: summary});
    } catch(err){
      logger.error("/api/getConversionSummary - error while retrieving data");
      logger.error(err);
      res.status(500).send({error: "Error while retrieving data"});
    }
  });

  /**
   * Gets all conversion rates stored in the database
   */
  app.get("/getConversionRate", (req, res) => {
    db.collection("base").findOne({name: "exchangeRates"}, (err, result) => {
      if(err){
        logger.error("/api/getConversionRate - " + err.stack);
        res.send({error: err});
      }
      res.send(result);
    });
  });
};
