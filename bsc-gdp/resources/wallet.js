// Sep 10 2020 (danie) - added storing of hot wallet into the database with encrypted keys
const MongoClient = require("mongodb").MongoClient;
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const readline = require("readline");
// load environmental values
require("dotenv").config();

const db = require("../config/db");
const logger = require("../config/winston");
const secUtil = require("../app/utils/security_utils");

const rl = readline.createInterface(process.stdin, process.stdout);
console.log(`DB: ${db.name}`);

var question = function (q) {
  return new Promise((res) => {
    rl.question(q, answer => {
      res(answer);
    });
  });
};

MongoClient.connect(db.url, async (err, database) => {
  if (err) return console.log(err);

  const walletDb = database.db(db.name);
  const base = walletDb.collection("base");
  const appPass = await base.findOne({name:"appPass"});
  if(!appPass) {
    console.log("No app password set. Please run the install script first.");
    process.exit(1);
  }
  let password = await question("App Password: ");
  if (bcrypt.compareSync(password, appPass.value)) {
    logger.info("Password match. Continuing with Hot Wallet Setup.");
    global.APP_HASH = crypto.createHash("md5").update(password).digest("hex");
  } else {
    console.log("Password doesn't match stored password. Exiting....");
    process.exit(1);
  }

  const sysAddress = walletDb.collection("system_address");  
  const type = (await question("What Blockchain? ")).trim().toUpperCase();

  console.log("=== Hot Wallet ===");
  const hotAddress = await question("Hot wallet address: ");
  let hotSecret = await question("Hot wallet secret: ");
  hotSecret = secUtil.encryptKey(hotSecret.trim());
  
  console.log("=== Cold Wallet ===");
  const coldAddress = await question("Cold wallet address: ");
  
  await sysAddress.updateOne({ type }, { $set:{ 
    hotSecret,
    hotAddress: hotAddress.trim(), 
    coldAddress: coldAddress.trim() } 
  }, { upsert:true });

  console.log("Done. Please restart wallet service to make use of new wallets.");
  process.exit(0);
});