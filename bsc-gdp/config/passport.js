const passport = require("passport");
const bcrypt = require("bcryptjs");
const LocalStrategy = require("passport-local").Strategy;

const dbUtil = require("../app/utils/db_utils");
const logger = require("./winston");

module.exports = function(app, db) {
  // Use the strategy that will authenticate the user based on their
  // username + password
  passport.use(new LocalStrategy(
    async function(username, password, cb){
      logger.debug("authenticating user " + username);
      try{
        let user = await dbUtil.retrieveUser(db, username);
        logger.debug("Retrieved user: " + JSON.stringify(user));
        if(!user) return cb(null, false);
        if(!bcrypt.compareSync(password, user.password)){
          logger.debug("Passwords don't match.");
          return cb(null, false);
        }else{
          logger.debug("Passwords match.");
          return cb(null, user);
        }
      } catch (err){
        return cb(err);
      }
    }
  ));


  // Serialize the user for keeping session persistence
  passport.serializeUser(function(user, cb){
    logger.debug("serializing user: " + user.username);
    cb(null, user.username);
  });

  // fetch user object from the database
  passport.deserializeUser(async function(username, cb) {
    logger.debug("deserializing user: " + username);
    const user = await dbUtil.retrieveUser(db, username);
    cb(null, user);
  });
  
}