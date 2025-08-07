import '@nomicfoundation/hardhat-toolbox';
import { HardhatUserConfig } from 'hardhat/config';
import 'umi-sdk';

require('dotenv').config();

const config: HardhatUserConfig = {
    defaultNetwork: 'devnet',
    solidity: '0.8.24',
    networks: {
        devnet: {
            url: 'https://devnet.uminetwork.com',
            accounts: [process.env.PRIVATE_KEY || ''],
        },
    },
};

export default config;
