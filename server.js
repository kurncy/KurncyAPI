const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const https = require('https');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const walletRoutes = require('./routes/wallet');
const kaspabalanceRoutes = require('./routes/kaspabalance');
const kaspatransactionsRoutes = require('./routes/kaspatransactions');
const kaspakrc20Routes = require('./routes/kaspakrc20');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';

// Trust proxy (nginx)
app.set('trust proxy', 1);

// Security Middleware for Production
if (ENV === 'production') {
    // Use Helmet for enhanced security headers
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"],
                connectSrc: ["'self'", "https://firebaseappcheck.googleapis.com", "https://*.kaspa.org"]
            }
        },
        crossOriginEmbedderPolicy: false,  // Modified for iOS compatibility
        crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },  // Modified for iOS compatibility
        crossOriginResourcePolicy: { policy: "cross-origin" }
    }));

    // CORS configuration for iOS App
    const corsOptions = {
        origin: (origin, callback) => {
            // Allow requests with no origin (like mobile apps)
            if (!origin) {
                return callback(null, true);
            }
            // Allow specific origins
            const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',');
            if (allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'],
        credentials: true,
        maxAge: 86400
    };
    app.use(cors(corsOptions));
    
    // Rate limiting with more specific configuration
    const limiter = rateLimit({
        windowMs: process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
        max: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
        message: {
            error: 'Too many requests from this IP, please try again later.',
            retryAfter: 'Check retry-after header for cooldown time'
        },
        standardHeaders: true,
        legacyHeaders: false
    });
    
    app.use(limiter);
} else {
    // Development: Allow all origins and headers
    app.use(cors({
        origin: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'],
        credentials: true,
        maxAge: 86400,
        preflightContinue: true
    }));
    
    // Log CORS preflight requests in development
    app.options('*', cors(), (req, res) => {
        console.log('🔄 Handling CORS preflight request');
        console.log('Origin:', req.headers.origin);
        console.log('Access-Control-Request-Headers:', req.headers['access-control-request-headers']);
        res.sendStatus(200);
    });
}

// Common middleware
app.use(express.json());
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));

// Cache for JWKS and verified tokens
const cache = new NodeCache({
    stdTTL: 3600, // 1 hour default TTL
    checkperiod: 600 // Check for expired keys every 10 minutes
});

// Initialize JWKS client
const jwksRsa = jwksClient({
    jwksUri: 'https://firebaseappcheck.googleapis.com/v1/jwks',
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 10
});

// Firebase App Check Middleware
const verifyAppCheck = async (req, res, next) => {
    if (ENV === 'development') {
        return next();
    }

    const appCheckToken = req.header('X-Firebase-AppCheck');
    
    if (!appCheckToken) {
        console.error('App Check Error: No token provided');
        return res.status(401).json({ error: 'No App Check token provided' });
    }

    try {
        // Parse the token
        let tokenData;
        try {
            tokenData = JSON.parse(appCheckToken);
            if (!tokenData.token) {
                throw new Error('Token field not found in JSON');
            }
        } catch (e) {
            console.error('App Check Error: Invalid token format', e);
            throw new Error('Invalid token format: Token must be a valid JSON string with a token field');
        }

        // Verify with Firebase App Check API using DeviceCheck
        const platformId = process.env.FIREBASE_PLATFORM_ID;
        const projectNumber = process.env.FIREBASE_PROJECT_NUMBER;
        
        // Decode the JWT to inspect its contents
        const decodedToken = jwt.decode(tokenData.token);
        console.log('🔍 Decoded token:', {
            sub: decodedToken?.sub,
            aud: decodedToken?.aud,
            provider: decodedToken?.provider,
            iss: decodedToken?.iss,
            exp: decodedToken?.exp,
            iat: decodedToken?.iat
        });

        // Verify the token's claims
        if (!decodedToken) {
            throw new Error('Invalid token format');
        }

        // Verify token hasn't expired
        const now = Math.floor(Date.now() / 1000);
        if (decodedToken.exp < now) {
            throw new Error('Token has expired');
        }

        // Verify issuer
        if (decodedToken.iss !== `https://firebaseappcheck.googleapis.com/${projectNumber}`) {
            throw new Error('Invalid token issuer');
        }

        // Verify audience includes our project
        if (!decodedToken.aud.includes(`projects/${projectNumber}`)) {
            throw new Error('Invalid token audience');
        }

        // Verify subject matches our app ID
        if (decodedToken.sub !== platformId) {
            throw new Error('Invalid token subject');
        }

        // Verify provider is DeviceCheck
        if (decodedToken.provider !== 'device_check_device_identification') {
            throw new Error('Invalid token provider');
        }

        // Get the public key to verify the signature
        const kid = decodedToken.kid || jwt.decode(tokenData.token, { complete: true })?.header?.kid;
        if (!kid) {
            throw new Error('No key ID found in token');
        }

        try {
            const key = await jwksRsa.getSigningKey(kid);
            const publicKey = key.getPublicKey();

            // Verify token signature
            const verified = jwt.verify(tokenData.token, publicKey, {
                algorithms: ['RS256'],
                audience: [`projects/${projectNumber}`, `projects/${process.env.FIREBASE_PROJECT_ID}`],
                issuer: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
                subject: platformId
            });

            console.log('✅ Token verification successful:', {
                token_valid: true,
                app_id: platformId,
                project_id: projectNumber,
                exp: new Date(verified.exp * 1000).toISOString()
            });

            // Store verification result in request
            req.appCheck = {
                verified: true,
                token: tokenData.token,
                exp: verified.exp,
                app_id: platformId,
                timestamp: new Date().toISOString()
            };

            next();
        } catch (error) {
            console.error('Token verification failed:', error);
            throw new Error(`Token verification failed: ${error.message}`);
        }
    } catch (error) {
        console.error('App Check Error:', {
            message: error.message,
            stack: error.stack,
            project_id: process.env.FIREBASE_PROJECT_ID,
            apple_team_id: process.env.APPLE_TEAM_ID,
            token_present: !!appCheckToken,
            token_value: appCheckToken
        });
        res.status(401).json({ 
            error: 'Unauthorized: Invalid App Check token', 
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
};

// Test route to verify server is running
app.get('/', (req, res) => {
    res.json({ 
        message: 'Kurncy API is running',
        environment: ENV
    });
});

// Test route specifically for App Check verification
app.get('/api/verify-app-check', verifyAppCheck, (req, res) => {
    // If we get here, it means the App Check verification passed
    res.json({
        success: true,
        message: 'App Check token verified successfully',
        data: {
            token: req.appCheck.token,
            expiration: new Date(req.appCheck.exp * 1000).toISOString(),
            app_id: req.appCheck.app_id,
            verification_time: req.appCheck.timestamp
        },
        status: "VERIFIED",
        code: 200,
        environment: ENV,
        timestamp: new Date().toISOString()
    });
});

// Routes with App Check verification
app.use('/api/wallet', verifyAppCheck, walletRoutes);
app.use('/api/kaspabalance', verifyAppCheck, kaspabalanceRoutes);
app.use('/api/kaspatransactions', verifyAppCheck, kaspatransactionsRoutes);
app.use('/api/kaspakrc20', verifyAppCheck, kaspakrc20Routes);

/**
 * @swagger
 * /api/krc20/mint2:
 *   post:
 *     tags: [KRC20]
 *     summary: Mint KRC20 tokens using optimized event-based UTXO tracking
 *     description: Mint KRC20 tokens with improved UTXO handling and transaction monitoring
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privateKey
 *               - ticker
 *               - amount
 *             properties:
 *               privateKey:
 *                 type: string
 *                 description: Private key for the source address
 *               ticker:
 *                 type: string
 *                 description: Token ticker symbol
 *               amount:
 *                 type: string
 *                 description: Amount to mint
 *               priorityFee:
 *                 type: string
 *                 description: Optional priority fee (default "0")
 *               iterations:
 *                 type: number
 *                 description: Optional number of mint iterations (minimum 20, default 20)
 *     responses:
 *       200:
 *         description: Minting successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 iterations:
 *                   type: number
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       iteration:
 *                         type: number
 *                       commitHash:
 *                         type: string
 *                       revealHash:
 *                         type: string
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Server error
 */

// Error handling middleware
app.use((err, req, res, next) => {
    // Log errors to Firebase in production
    if (ENV === 'production' && req.user) {
        admin.firestore().collection('error_logs').add({
            userId: req.user.uid,
            error: err.message,
            stack: err.stack,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            path: req.path,
            method: req.method
        }).catch(console.error);
    }
    
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not Found',
        path: req.path,
        method: req.method
    });
});

// Server startup based on environment
if (ENV === 'production') {
    // HTTP for production (nginx will handle HTTPS)
    app.listen(PORT, 'localhost', () => {
        console.log(`Server running on localhost:${PORT} in ${ENV} mode`);
    });
} else {
    // HTTP for development
    app.listen(PORT, 'localhost', () => {
        console.log(`Server running on localhost:${PORT} in ${ENV} mode`);
    });
}

module.exports = app; 