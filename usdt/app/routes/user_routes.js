const passport = require("passport");
const bcrypt = require("bcrypt");

const dbUtils = require("../utils/db_utils");
const logger = require("../../config/winston");
const {isLoggedIn, hasPermissionAction} = require("../utils/route_utils");

module.exports = function(app, db) {
  app.post("/login",
    passport.authenticate("local"),
    function(req, res){
      logger.debug("logging in user " + req.body.username);
      res.send({status: "OK"});
    }); 

  app.post("/logout", function(req, res){
    logger.debug("/logout - logging out: " + req.user.username);
    req.logout();
    res.send({status: "OK"});
  });

  app.post("/editUser",[isLoggedIn, hasPermissionAction], async function(req, res){
    const {username, password, permissions} = req.body;
    let permList = [];
    if(permissions) permList = permissions.map(p => p.code);
    let user = await dbUtils.retrieveUser(db, username);
    let hash = bcrypt.hashSync(password, 10);
    let newUser = {username, password:hash, permissions: permList};
    if(user){
      logger.info("Updating user with username: " + username);
      await db.collection("user").update({username}, newUser);
      res.send({status: "OK", action:"edit", user: username});
    } else {
      logger.info("Creating user with username: " + username);
      await db.collection("user").insert(newUser);
      res.send({status:"OK", action:"create",user: username});
    }

  });

};