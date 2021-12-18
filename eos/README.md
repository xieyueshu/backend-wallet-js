# Wallet Service

An engine that manages blockchain wallets by automating transfers and detecting transactions. Supported blockchains include: Ambertime, Ethereum, Bitcoin (with Omni protocol support), and LTK.

# Dependencies: 
1. [NodeJS](https://nodejs.org/en/) version 8 and later (latest version tested is with version 10.6.3. Node 10.17.0 breaks wallet-service!)
2. [MongoDB](https://www.mongodb.com/) version 3.6 (untested on mongo DB version 4.0 and above)

# Installation (quick start):
1. Run `npm install` on the command line while in the project folder to download the projects dependencies.
2. Duplicate the *.env.example* file, remove the .example extension at the end so that the .env name is left. 
3. Duplicate the .example files inside the *config* folder and remove the .example at the end to create the config files.
4. Change the url and db values in the *db.js* file to point to the mongoDB that will be used.
5. Run the command `node resources/install.js` to run the installation script and add the required database records.

# Running:
To run the program, type `node app -p <password>` on the command line while 
in the project folder. The password is the application password that will be asked for when the installation script is being run.

The admin console will be accessible at port **8000**. The user used to login will also be asked for in the installation script.

# API Documentation
API documentation available [here](https://documenter.getpostman.com/view/7491713/SVfTN76H?version=latest).