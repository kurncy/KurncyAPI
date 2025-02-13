# Kurncy API V1

Kurncy API is a secure and scalable backend service for managing Kaspa blockchain transactions, KRC-20 tokens, and wallet operations.

## Features

### Wallet Management
- ✨ Create new wallets with mnemonic phrases
- 🔐 Import existing wallets via private key or mnemonic
- 💼 Multi-wallet support
- 📊 Real-time balance tracking

### Kaspa Transactions
- 💸 Send and receive KAS
- ⚡ Fast transaction processing
- 💰 UTXO optimization
- 📈 Dynamic fee estimation

### KRC-20 Token Support
- 🪙 Mint KRC-20 tokens
- 💱 Token transfers with fee estimation

## Security

The API implements several security measures:

1. **Firebase App Check**
   - Prevents unauthorized API access
   - Validates client authenticity

2. **Rate Limiting**
   - Prevents abuse and DDoS attacks
   - Configurable limits per IP/endpoint

3. **SSL/TLS**
   - Required for production deployment
   - Secures all API communications

4. **CORS Protection**
   - Configurable allowed origins
   - Prevents unauthorized cross-origin requests

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support, please contact support@kurncy.com or join our [Discord community](https://discord.gg/pRPWECg9). 
