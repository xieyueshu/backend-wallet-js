/**
 * Starts up the app. First connects to the database in order to retrieve the password.
 *  - If no password has been provided, the app quits. 
 *  - If the password doesn't match the one stored in the database, the app
 *    exits.
 *  - If the password matches the one stored in the database, the app is
 *    started and a child process is created for the batch jobs.
 */

const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const path = require("path");
const bodyParser = require("body-parser");
const MongoClient = require("mongodb").MongoClient;
const helmet = require("helmet");
const passport = require("passport");
const fs = require("fs");
const morgan = require ("morgan");

// load environmental values
dotenv.config();
const app = express();
const PORT = process.env.PORT;

const db = require("./config/db");
const logger = require("./config/winston");
const settingUtil = require("./app/utils/setting_utils");
const secUtil = require("./app/utils/security_utils");
const base = require("./app/utils/base_utils");

if (process.env.NODE_ENV === "development")
  console.clear(); // for clearing the nodemon console

MongoClient.connect(db.url, (err, database) => {
  if (err) return console.log(err);

  const walletDb = database.db(db.name);
  // check if there are arguments provided
  if (process.argv.length < 3) {
    console.log("Password required to start the engine.");
    console.log("Run the engine with the command: node app -p <your-password-here>");
    logger.debug("No password provided");
    process.exit(1);
  } else {
    let args = process.argv;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-p" || args[i] === "-P") {
        // the argument after "-p"/"-P" is the password argument
        let password = args[i + 1];
        if (password) {
          walletDb.collection("base").findOne({
            name: "appPass"
          }, (err, dbPass) => {
            if (err) {
              logger.error(err.stack);
              console.log("An error occurred.");
              process.exit(1);
            } else {
              logger.debug("Retrieved password");
              if (dbPass) {
                // check if the passwords match
                if (bcrypt.compareSync(password, dbPass.value)) {
                  logger.info("Engine startup success");
                } else {
                  logger.debug("Passwords don't match....");
                  console.log("Password doesn't match stored password. Exiting....");
                  process.exit(1);
                }
              } else {
                console.log("Creating a new password...");
                logger.debug("Generating password hash.");
                let hash = bcrypt.hashSync(password, 10);
                walletDb.collection("base").insert({
                  name: "appPass",
                  value: hash
                });
              }
              // store the password hash in a global variable
              global.APP_HASH = crypto.createHash("md5").update(password).digest("hex");

              // load the API key
              let sharedKey = fs.readFileSync("config/key.cfg", "utf8");
              // decrypt the shared key
              const encoded = sharedKey.match(/ENC\((.*)\)/); 
              if(encoded) {
                sharedKey = secUtil.decryptSecret(encoded[1]);
              }
              global.SHARED_KEY = sharedKey.trim();
							
              // Sep 10 2020 (danie) - loaded the system addresses
              settingUtil.loadSystemWallets(walletDb);

              //load the settings
              settingUtil.loadSettings(walletDb);
              base.loadValue(walletDb, "asset");

              // set the views and public folders for pages
              app.set("view engine", "ejs");
              app.set("views", path.join(__dirname + "/views/"));
              app.use(express.static(__dirname + "/public"));
              app.use(morgan("combined"));

              app.use(helmet());
              app.use(bodyParser.urlencoded({
                extended: true
              }));
              app.use(bodyParser.json());
              app.use(session({
                secret: "wallet-services3cr3t",
                resave: false,
                name: "wallet" + PORT,
                saveUninitialized: false,
                cookie: {
                  maxAge: 1800000
                }
              }));

              // configure the app to use passport
              require("./config/passport")(app, walletDb);
              app.use(passport.initialize());
              app.use(passport.session());

              // load the routes 
              require("./app/routes")(app, walletDb);

              if (process.env.SEPARATE_JOB === "N") {
                // create a child process for running the batch jobs
                const cp = require("child_process");
                cp.fork(__dirname + "/app/jobs/index.js", [global.APP_HASH, global.SHARED_KEY], {
                  env: process.env
                });
                if (process.env.CHAIN_SUPPORT.includes("BTC") && process.env.RUN_DEPOSIT_JOB === "Y" && process.env.BTC_INSIGHT_SUPPORT === "Y") {
                  cp.fork(__dirname + "/app/listeners/index.js", [global.APP_HASH, global.SHARED_KEY], {
                    env: process.env
                  });
                }
              }
							

              app.listen(PORT,'0.0.0.0', () => {
                logger.info("Engine is currently running and listening on port " + PORT);
              });
            }
          });
        } else {
          console.log("No password provided");
          console.log("Run the engine with the command: node app -p <your-password-here>");
          logger.debug("No password provided.... exiting.");
          process.exit(1);
        }
        break;
      }
    }
  }


});
