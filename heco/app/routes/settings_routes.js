const setting_utils = require("../utils/setting_utils");
const security_utils = require("../utils/security_utils");
const routeUtil = require("../utils/route_utils");
const amtUtil = require("../utils/amt_utils");
const logger = require("../../config/winston");
const {isLoggedIn, passwordMiddleware} = require("../utils/route_utils");


module.exports = function(app, db) {
  app.get("/getSetting", isLoggedIn, async (req,res) => {
    logger.info("/getSetting - Getting settings");
    let name;
    if(req.query.name) name = req.query.name.toUpperCase();
    try {
      const settings = await setting_utils.getSetting(db, name);
      logger.debug("/getSetting - settings found: " + JSON.stringify(settings));
      return res.send(settings);
    } catch(err) {
      logger.error("/getSetting - " + err.stack);
      return res.send({error: "unable to retrieve settings"});
    }
  });

  // Sep 10 2020 (danie) - added setting of multiple settings
  app.post("/setSetting", [isLoggedIn, passwordMiddleware], async (req,res) => {
    let isMatch = await security_utils.passwordMatch(db, "settingPass", req.body.password);
    if(!isMatch){
      logger.warn("/setSetting - password doesn't match");
      return routeUtil.after(req,res,{
        res: {error: "passwords don't match"},
        redirectQuery: "/?request=settings&status=fail"
      });
    }
    
    let newSettings = {};
    let name = "";
    if(req.body.name) {
      name = req.body.name.toUpperCase();
      newSettings[name] = req.body.value;
    } else if (req.body.settings) { 
      for(const name in req.body.settings) newSettings[name] = req.body.settings[name];
    } else {
      logger.info("/setSetting - name not provided");
      return routeUtil.after(req,res,{
        res:{error: "name is required"},
        redirectQuery: "/?request=settings&status=fail"
      });
    }
    logger.info("/setSetting - setting " + JSON.stringify(newSettings));
    logger.debug(`/setSetting - checking if user ${req.user.username} has permission to set ${name}`);
    if(!hasSettingPermission(name, req.user.permissions)) return res.status(401).send({error: "Unauthorized"});

    try {
      await db.collection("base").findOneAndUpdate({name:"settings"}, {$set:newSettings});
      setting_utils.loadSettings(db);
      return routeUtil.after(req,res,{
        res: newSettings,
        redirectQuery: "/?request=settings&status=success"
      });
    } catch (err){
      logger.error("/setSetting - " + err.stack);
      return routeUtil.after(req,res,{
        res:{error: "unable to update settings"},
        redirectQuery: "/?request=settings&status=fail"
      });
    }
  });

  //Nov 12,2020 (Zhen) - added fil
  app.get("/getMinConfirmation", (req,res) => {
    logger.info("/getMinConfirmation - Getting minimum confirmaition");
    let type;
    if(req.query.coinType){
      type = req.query.coinType.toUpperCase();
    } else {
      return res.send({error: "coinType is required"});
    }
    if(type === "AMT" || amtUtil.isAmtAsset(type)){
      res.send({value: process.env.AMT_CONFIRMATION_COUNT});
    } else if (type === "ETH" || type === "AMTC"){
      res.send({value: process.env.ETH_CONFIRMATION_COUNT});
    } else if (type === "FIL"){
      res.send({value: process.env.FIL_CONFIRMATION_COUNT});			
    } else {
      res.send({error: "provided type is not supported"});
    }
  });
};

/** 
 * check if the user has the permissions to set the settings for different modules
 */
const hasSettingPermission = (name, permissions) => {
  if(name.indexOf("WITHDRAW") !== -1 && permissions.indexOf("viewWithdrawRequest") === -1)
    return false;

  return true;

};
