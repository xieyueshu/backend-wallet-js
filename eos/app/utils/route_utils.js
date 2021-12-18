const logger = require("../../config/winston");

const after = (req, res, resObj) => {
  let redirect = req.body.redirect;
  if (redirect) {
    redirect += resObj.redirectQuery;
    logger.debug("route_utils.after -  redirecting to " + redirect);
    res.redirect(redirect);
  } else {
    logger.debug("route_utils.after -  sending " + JSON.stringify(resObj.res));
    res.send(resObj.res);
  }
}

const passwordMiddleware = (req, res, next) => {
  let password = req.body.password;
  if (!password) {
    logger.warn("passwordMiddleware - password is blank");
    res.send({
      error: "Password can't be blank"
    });
  } else {
    next();
  }
}

const isLoggedIn = (req, res, next) => {
  if (req.isAuthenticated()) {
    next();
  } else {
    res.status(401).redirect('/admin/login');
  }
}

const hasPermissionPage = (req, res, next) => {
  const userPerm = req.user.permissions;
  const url = req.url;
  logger.debug(`Checking if user ${req.user.username} has permission`);
  logger.debug('URL accessed: ' + url);
  if (url.indexOf("/user") !== -1 && userPerm.indexOf("viewUsers") !== -1) {
    next();
  } else if ("/admin/withdraw" === url && (userPerm.indexOf("viewWithdraw") !== -1 || userPerm.indexOf("viewWithdrawRequest") !== -1)) {
    next();
  } else if (url.indexOf("/withdraw/transactions") !== -1 && userPerm.indexOf("viewWithdraw") !== -1) {
    next();
  } else if (url.indexOf("/withdraw/requests") !== -1 && userPerm.indexOf("viewWithdrawRequest") !== -1) {
    next();
  } else if (url.indexOf("/deposit") !== -1 && userPerm.indexOf("viewDeposit") !== -1) {
    next();
  } else if (url.indexOf("/sent") !== -1 && userPerm.indexOf("viewSent") !== -1) {
    next();
  } else {
    logger.debug(`Permission denied for ${req.user.username}`);
    res.status(401).redirect('/admin/unauthorized');
  }
}

const hasPermissionAction = (req, res, next) => {
  const userPerm = req.user.permissions;
  const url = req.url;
  logger.debug(`Checking if user ${req.user.username} has permission`);
  logger.debug('action called: ' + url);
  if (url.indexOf("Withdrawal") !== -1 && userPerm.indexOf("viewWithdrawRequest") !== -1) {
    next();
  } else if (url.indexOf("Transaction") !== -1 && userPerm.indexOf("viewWithdraw") !== -1) {
    next();
  } else if (url === "/triggerDeposit" && userPerm.indexOf("transferCold") !== -1) {
    next();
  } else if (url === "/triggerEthTransfer" && userPerm.indexOf("transferGas") !== -1) {
    next();
  } else if (url === "/setConversionRate" && userPerm.indexOf("updateRates") !== -1) {
    next();
  } else if (url === "/editUser" && userPerm.indexOf("viewUsers") !== -1) {
    next();
  } else if (url.indexOf("MarkedAddress") !== -1 && userPerm.indexOf("addMarked") !== -1) {
    next();
  } else {
    logger.debug(`Permission denied for ${req.user.username}`);
    res.status(401).send({
      error: "Unauthorized"
    });
  }
}

module.exports = {
  after,
  passwordMiddleware,
  isLoggedIn,
  hasPermissionPage,
  hasPermissionAction
}