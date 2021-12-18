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
                logger.debug('Logged address ' + address.address);
            });
        }
    }

};