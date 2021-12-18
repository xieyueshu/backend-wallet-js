const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const flatten = require("flat");
const logger = require("../../config/winston");

const algorithm = process.env.ENCRYPTION_ALGORITHM || 'aes-128-cbc-hmac-sha1';

const encrypt = (key, secret) => {
	logger.debug("Encrypting key..");
	const cipherKey = secret || global.APP_HASH;
	var cipher = null;
	if(cipherKey === global.APP_HASH) {
		cipher = crypto.createCipher("aes-128-cbc-hmac-sha1", cipherKey)
	} else {
		// get the first 32 bytes as the key
		const key = global.SHARED_KEY.substr(0, 32);
		// get the last 16 bytes as the iv
		const iv = global.SHARED_KEY.substr(global.SHARED_KEY.length - 16);
		cipher = crypto.createCipheriv(algorithm, key, iv);
	}
	var crypted = cipher.update(key, 'utf8', 'hex')
	crypted += cipher.final('hex');
	return crypted;
}

const decrypt = (key, secret) => {
	logger.debug("Decrypting key..");
	const cipherKey = secret || global.APP_HASH;
	var decipher = null;
	if(cipherKey === global.APP_HASH) {
		decipher = crypto.createDecipher("aes-128-cbc-hmac-sha1", cipherKey)
	} else {
		// get the first 32 bytes as the key
		const key = global.SHARED_KEY.substr(0, 32);
		// get the last 16 bytes as the iv
		const iv = global.SHARED_KEY.substr(global.SHARED_KEY.length - 16);
		decipher = crypto.createDecipheriv(algorithm, key, iv);
	}
	var dec = decipher.update(key, 'hex', 'utf8')
	dec += decipher.final('utf8');
	return dec;
}

module.exports = {
	encrypt,
	decrypt,
	createRaw: (data) => {
		let rawStr = "";
    if (typeof data === "string") {
      rawStr = data;
    } else if (typeof data === "object") {
      const flat = flatten(data);
      Object.keys(flat)
        .sort()
        .forEach((k, i) => {
          rawStr += flat[k];
        });
    } else {
      rawStr = data.toString();
    }
    logger.debug(`raw String: ${rawStr}`);
    return rawStr;
	},
	/**
	 * Create a general signature; body contains the "sign" which is the signature generated
	 */
	validateSignature: (body) => {
		const data = Object.assign(body);
		const sign = data.sign;
		delete data.sign;
		const raw = module.exports.createRaw(data);
		const generated = module.exports.sign(raw);
		logger.debug(`sign: ${sign}; generated: ${generated}`);
		return sign === generated;
	},
	/**
	 * Create the signature based on a shared key
	 */
	signData: (data) => {
		const raw = module.exports.createRaw(data);
		return module.exports.sign(raw);
	},
	/**
	 * Create the signature based on a shared key
	 */
	sign: (data) => {
		logger.info("security_utils.sign - Signing: " + data);
		return crypto.createHash('md5').update(data + global.SHARED_KEY).digest("hex");
	},
	/**
	 * Encrpypt the private key with the hash from the password
	 */
	encryptKey: (key, secret = null) => {
		return encrypt(key);
	},
	/**
	 * Decrypt the private key with the hash from the password
	 */
	decryptKey: (key, secret = null) => {
		return decrypt(key);
	},
	/**
	 * Encrpypt the data with the shared secret
	 */
	encryptSecret: (key) => {
		return encrypt(key, global.SHARED_KEY);
	},
	/**
	 * Decrypt the data with the shared secret
	 */
	decryptSecret: (key, secret = null) => {
		return decrypt(key, global.SHARED_KEY);
	},
	
	/**
	 * Verifies password provided. Return true if the password matches the one stored in the database. 
	 * (passwords are stored in the base table and have different names)
	 */
	passwordMatch: async (db, name, password) => {
		try {
			let passRec = await db.collection("base").findOne({
				name
			});
			logger.debug("retrieved " + name + " password");
			return bcrypt.compareSync(password, passRec.value);
		} catch (err) {
			logger.error("security_utils.passwordMatch - error: " + err.stack);
		}
	},
	toJSON(text){
    if (typeof text!=="string"){
        return false;
    }
    try{
        JSON.parse(text);
        return true;
    }
    catch (error){
        return false;
    }
	}
};