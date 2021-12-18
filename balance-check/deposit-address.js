require("dotenv").config();
const MongoClient = require("mongodb").MongoClient;
const dbconfig = require("./config/db");
const logger = require("./config/winston");
const checker = require("./balance-check");

const getDepositedAddresses = async (db) => {
  return await db.collection("transaction").aggregate([{
    $match: {
      txnType: "D"
    }
  }, {
    $group: {
      _id: "$recepient"
    }
  }]).toArray();
};

async function processDb(dbconfig) {
  try {
    const database = await MongoClient.connect(dbconfig.url,{ useUnifiedTopology: true });
    const db= database.db(dbconfig.name);        
    try {
      const addresses=await getDepositedAddresses(db);
      const coin = dbconfig.chain.trim().toLowerCase();
      let contract=null;
      const token = dbconfig.contract;
      logger.info("Checking contract " + token);
      if (token && token.trim()!==""){
        const decimal = dbconfig.contractDecimal; 
        contract = {
          hash : token.trim().toLowerCase(),
          decimals : decimal
        };                
      }
      await checker(db, addresses, coin, contract);
    } catch (e) {
      logger.error(e);            
    }
    await database.close();
  } catch (err) {
    logger.error("Unable to connect to database - " + err.stack);
    return;
  }
}

const main = async() => {
  for(const config of dbconfig) {
    logger.info(`Processing db:${config.name} with chain ${config.chain}`);
    await processDb(config);
  }
};

main();