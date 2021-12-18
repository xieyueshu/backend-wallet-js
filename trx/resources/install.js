const MongoClient = require("mongodb").MongoClient;
const bcrypt = require("bcrypt");
const readline = require("readline");
// load environmental values
require("dotenv").config();

const db = require("../config/db");
const defaults = require("./install/defaults.js");

const rl = readline.createInterface(process.stdin, process.stdout);
console.log(`DB: ${db.name}`);
console.log(defaults);

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
  // Sep 10 2020 (danie) - Added query for sent, rate, and transfer permissions
  const sent = await question("Will there be sending transactions (Y/N)? ");
  if(sent !== "Y") defaults.permission = defaults.permission.filter(p => p.code !== "viewSent");

  const rates = await question("Will there be rate API (Y/N)? ");
  if(rates !== "Y") defaults.permission = defaults.permission.filter(p => p.code !== "updateRates");
	
  const manualTransfer = await question("Is deposit transfer manual (Y/N)? ");
  if(manualTransfer !== "Y") {
    defaults.permission = defaults.permission.filter(p => p.code !== "transferGas" && p.code !== "transferCold");
  } 
	
  await walletDb.collection("permission").insertMany(defaults.permission);
  console.log(`Inserted ${defaults.permission.length} permissions`);

  let base = defaults.base;
  let password = await question("What is the application password? ");
  base.push({
    name: "appPass",
    value: bcrypt.hashSync(password, 10)
  });

  password = await question("What is the secondary password? ");
  const secondPassFields = ["settingPass", "coldPass", "gasPass", "updatePass"];
  for(const field of secondPassFields) {
    base.push({
      name: field,
      value: bcrypt.hashSync(password, 10)
    });
  }

  password = await question("Is there an Ambertime asset that will be monitored (Y to set-up asset details)? ");
  const asset = { name:"asset" };
  if(password.trim().toUpperCase() === "Y") {
    const name = await question("What is the asset's name? ");
    const assetref = await question("What is the asset's reference (eg.338249-268-38755)? ");
    asset.value = { name, assetref };
  }
  base.push(asset);


  await walletDb.collection("base").insertMany(base);
  console.log(`Inserted ${base.length} records into base`);

  let permissions = defaults.permission.map(p => p.code);
  let user = await question("Front-end user name: ");
  let pass = await question("Front-end user password: ");
  pass = bcrypt.hashSync(pass, 10);
  let userRecord = {
    username: user,
    password: pass,
    permissions
  };
  await walletDb.collection("user").insertOne(userRecord);
  console.log(`Inserted user ${user}`);

  // create transaction and withdraw_request tables with indexes
  await walletDb.createCollection("transaction");
  await walletDb.collection("transaction").createIndex({"$**": "text"});
	
  await walletDb.createCollection("withdraw_request");
  await walletDb.collection("withdraw_request").createIndex({"$**": "text"});

  console.log("Done. You can now run the app using the command `node app -- -p <app password>`");
  process.exit(0);
});