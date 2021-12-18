var fs = require("fs");
const Web3 = require("web3");

const dbUtils = require("../utils/db_utils");
const ethUtils = require("../utils/eth_utils");
const {isLoggedIn, hasPermissionPage} = require("../utils/route_utils");
const logger = require("../../config/winston");
const setting_utils = require("../utils/setting_utils");
const { default: BigNumber } = require("bignumber.js");

module.exports = function(app, db) {	/**
	* Front-end page for seeing summary of withdraw records
	*/	
  app.get("/admin/login/", async (req, res) => {
    res.render("login");
  });


  app.get("/admin/unauthorized", async (req, res) => {
    res.render("error_401");
  });


  app.get("/admin/user/register", [isLoggedIn,hasPermissionPage], async(req, res) => {
    let viewSettings = getSettings();
    let userPermissions = await dbUtils.retrieveUserPermissions(db);
    let user = {username: "", password: "", permissions:[]};
    let dashProps = getDashboardList(req.user.permissions);
    res.render("register", {viewSettings, userPermissions, user, title:"Create User", dashProps});
  });

  app.get("/admin/user", [isLoggedIn, hasPermissionPage], async(req, res) => {
    let viewSettings = getSettings();
    let user = await dbUtils.retrieveUser(db);
    let dashProps = getDashboardList(req.user.permissions);
    res.render("userlist", {userPermissions: user, viewSettings, dashProps});
  });

  app.get("/admin/user/details/:name",[isLoggedIn, hasPermissionPage], async(req, res) => {
    let viewSettings = getSettings();
    let userPermissions = await dbUtils.retrieveUserPermissions(db);
    let user = await dbUtils.retrieveUser(db, req.params.name);
    let dashProps = getDashboardList(req.user.permissions);
    res.render("register", {viewSettings, userPermissions, user, title:"Edit User", dashProps});
  });

  /**
	 * Front-end page for seeing summary of withdraw records
	 */	
  app.get("/admin/withdraw/", [isLoggedIn, hasPermissionPage], async (req, res) => {
    let viewSettings = getSettings();
    let dashProps = getDashboardList(req.user.permissions);
    res.render("dashboard/dashboard_withdraw", {viewSettings, permissions:req.user.permissions, dashProps});
  });

  /**
	 * Front-end page to show withdraw records
	 */
  app.get("/admin/withdraw/:table", [isLoggedIn, hasPermissionPage], async (req, res) => {
    logger.info("/admin/withdraw/ - GET table " + req.params.table);
    let viewSettings = getSettings();
    let dashProps = getDashboardList(req.user.permissions);
    let query = {coin: req.query.coin, table: req.query.table, viewSettings, dashProps};
    res.render("withdraw_admin/withdraw_admin_" + req.params.table, query, function(err, html) {
      if (err) {
        logger.error("/admin/withdraw/" + err.stack);
        if(err.message.includes("Failed to lookup view"))
          return res.status(404).render("error_404");
        else 
          return res.status(500).render("error_server");
      }
      res.send(html);
    });
  });

  /**
	 * Front-end page for seeing summary of deposit records
	 */	
  app.get("/admin/deposit/", [isLoggedIn,hasPermissionPage], async (req, res) => {
    let viewSettings = getSettings();
    let dashProps = getDashboardList(req.user.permissions);
    res.render("deposit_admin/deposit_admin_transactions", {viewSettings, dashProps});
  });

  app.get("/admin/sent/", [isLoggedIn,hasPermissionPage], async (req, res) => {
    let viewSettings = getSettings();
    let dashProps = getDashboardList(req.user.permissions);
    res.render("sent_admin/sent_transactions", {viewSettings, dashProps});
  });

  app.get("/", isLoggedIn, (req, res) => {
    return res.redirect("/admin/dashboard");
  });

  app.get("/admin", isLoggedIn, (req, res) => {
    return res.redirect("/admin/dashboard");
  });
	
  /**
	 * Front-end for updating coin rates, adding/removing marked addresses, and 
	 * triggering hot wallet transfers
	 */	
  app.get("/admin/dashboard", isLoggedIn, async (req, res) => {
    try{ 
      let data = {};
      let dashProps = getDashboardList(req.user.permissions);
      let rates = await db.collection("base").findOne({name:"exchangeRates"}, {fields:{_id:0}});
      data["currency"] = (rates) ? rates : {};
			
      let markedAddr = await db.collection("marked_address").find({}, {fields:{_id:0}}).toArray();
      data["marked"] = markedAddr;

      let viewSettings = getSettings();
      data["cold"] = getColdWallets(viewSettings);
      // Sep 10 2020 (danie) - added retrieval of env settings
      const envSettings = await setting_utils.getEnvSettings(db);
      data["env"] = envSettings;

      // Sep 16 2020 (danie) - added gas settings
      // Sep 17 2020 (danie) - refactored retrieval of gas settings
      if(!process.env.CHAIN_SUPPORT.includes("ETH")) {
        data["gas"] = {};
      } else {
        data["gas"] = await getEthGasInfo(db);
      }

      res.render("dashboard/dashboard_admin", {data, viewSettings, permissions:req.user.permissions, dashProps});
    } catch(err){
      logger.error("/admin/dashboard - " + err.stack);
      return res.status(500).render("error_server");
    }
  });

  // Sep 17 2020 (danie) - added route to retrieve gas information
  app.get("/admin/gasInfo", isLoggedIn, async (req, res) => {
    const gasInfo = await getEthGasInfo(db);
    return res.send(gasInfo);
  });
};
	
// Sep 17 2020 (danie) - added function for retrieval of gas info
const getEthGasInfo = async (db) => {
  const basePrice = await ethUtils.getAverageGasPrice(db);
  return {
    baseGasPrice: basePrice.toString(),
    gasPrice: new BigNumber(basePrice).times(process.env.ETH_GAS_PRICE_MULTIPLIER).toString(),
    gasAmount: await ethUtils.getGasInEth(db, new Web3(ethUtils.WEB3_PROVIDER))
  };
};


const getSettings = () => {
  var obj = JSON.parse(fs.readFileSync("config/view_settings.json", "utf8"));
  return obj;
};

const getDashboardList = (permissions) => {
  let props = [ 
    { label: "Dashboard 仪表板", id: "dashboard", icon: "dashboard" },
  ];
		
  if(permissions.indexOf("viewWithdraw") === -1 && permissions.indexOf("viewWithdrawRequest") === -1){
    props.splice(1, 1);
  } else {
    let withdrawItem = { label: "Withdrawal Section  提币概览", id: "wd_section", icon: "business_center" };
    let withdrawChildren = [];
    if(permissions.indexOf("viewWithdraw") !== -1)
      withdrawChildren.push({ label: "Withdrawal Transactions 提币交易", id: "wd_transaction", icon: "swap_horizontal_circle" });
    if(permissions.indexOf("viewWithdrawRequest") !== -1)
      withdrawChildren.push({ label: "Withdrawal Requests 提币请求", id: "wd_request", icon: "swap_vertical_circle"  } );
    withdrawItem.children = withdrawChildren;
    props.push(withdrawItem);
  }
  if(permissions.indexOf("viewDeposit") !== -1)
    props.push({ label: "Deposit 充值交易", id: "deposit", icon: "business_center"});
  if(permissions.indexOf("viewSent") !== -1)
    props.push({ label: "Sent 转币交易", id: "sent", icon: "send"});
  if(permissions.indexOf("viewUsers") !== -1)
    props.push({ label: "Users 用户维护", id: "users", icon: "group" } );

  return props;
};

// Sep 9 2020 (danie) - added TRX cold wallet
const getColdWallets = (settings) => {
  let wallet = [];
  let chainList = process.env.CHAIN_SUPPORT;
  // Sep 10 2020 (danie) - changed variable name for eth system wallets
  // Nov 12 2020 (zhen) - added fil
  if (chainList.includes("ETH")) {
    wallet.push({coin:settings.coin_names.eth || "ETH", address:process.env.ETH_COLD_WALLET});
  }
  if (chainList.includes("AMTC")) {
    wallet.push({coin:settings.coin_names.amtc || "AMTC", address: process.env.ETH_COLD_WALLET});
  }
  if (chainList.includes("BTC")) {
    wallet.push({coin:settings.coin_names.btc || "BTC",address:process.env.BTC_COLD_WALLET});
  }
  if (chainList.includes("AMT")) {
    wallet.push({coin:settings.coin_names.amt || "AMT",address:process.env.AMT_COLD_WALLET});
  }
  if (chainList.includes("TRX")) {
    wallet.push({coin:settings.coin_names.trx || "TRX",address:process.env.TRX_COLD_WALLET});
  }	
  if (chainList.includes("FIL")) {
    wallet.push({coin:settings.coin_names.fil || "FIL",address:process.env.FIL_COLD_WALLET});
  }
  return wallet;
};