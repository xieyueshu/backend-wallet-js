const fs = require("fs");

const logger = require("../../config/winston");

module.exports = {
  /**
     * Append the address to a file for safe-keeping
     */
  appendAddress: (address) => {
    if (process.env.ADDRESS_LOG_FILE.length > 0) {
      let addrTxt = JSON.stringify(address) + "\n";
      let addrLoc = process.env.ADDRESS_LOG_FILE.replace("${type}", address.type);
      fs.appendFile(addrLoc, addrTxt, function (err) {
        if (err) throw err;
        logger.debug("Logged address " + address.address);
      });
    }
  },    
  findAddress:async (res,crypto,address,type) => {
    if (process.env.ADDRESS_LOG_FILE.length > 0) {
      let addrLoc = process.env.ADDRESS_LOG_FILE.replace("${type}", type);
      await fs.readFile(addrLoc,(err,data)=>{
        if (err) throw err;
        let lines = new String(data).split("\n");
        logger.debug("data has " + lines.length +"  lines");
        for (let x=0;x<lines.length;x++){
          let txt = lines[x].trim();
          if (txt.length>0){
            let obj = JSON.parse(txt);
            logger.debug(obj.address);
            if (obj.address==address){
              logger.debug("found key " + JSON.stringify());
              res.send(JSON.stringify(obj));
              return;	                      
            }
          }
        } 
        res.send("{error : \"not found\"}");              			
      });
    }
  }
};
