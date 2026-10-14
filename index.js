const express = require('express')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { escapeSearchText, isValidTrackingNumber, parseBearerToken } = require('./utils/request-security')
require('dotenv').config();
const app = express()
const port = process.env.PORT || 3000;
const stripe = require('stripe')(process.env.STRIPE_PAYMENT)

const crypto = require('crypto')
function generateTrackingId() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '') // YYYYMMDD
  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase() // 6 hex chars
  return `ZAP${datePart}${randomPart}` // Example: ZAP20251122A1B2C3
}

// firebase verify 
const admin = require("firebase-admin");
// const serviceAccount = require('./zab-shift-firebase-adminsdk-fbsvc-a62efd09f0.json');
const { count } = require('console');
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


// middleware
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.SITE_DOMAIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID()
  res.setHeader('x-request-id', req.requestId)
  next()
})
app.use(helmet())
app.use(express.json({ limit: '100kb' }))
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin))
}))
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}))

const trackingRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false
})

const verifyFBToken = async (req, res, next) => {
  const idToken = parseBearerToken(req.get('authorization'))
  if (!idToken) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken)
    req.decoded_email = decoded.email
    next()
  }
  catch (err) {
    return res.status(401).send({ message: 'unauthorized access' })

  }
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.f47fo9z.mongodb.net/?appName=Cluster0`;

app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' })
})

app.get('/', (req, res) => {
  res.send('zap shift server')
})

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // await client.connect();

    const db = client.db('Zab-Shift')
    const userConnection = db.collection('users')
    const parcelConnection = db.collection('parcels')
    const paymentConnection = db.collection('payment')
    const riderConnection = db.collection('rider')
    const trackingConnection = db.collection('tracking')


    // verify with more database access with admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email
      const query = { email }
      const user = await userConnection.findOne(query)
      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' })
      }
      next()
    }
    // verify with more database access 
    const verifyRider = async (req, res, next) => {
      const email = req.decoded_email
      const query = { email }
      const user = await userConnection.findOne(query)
      if (!user || user.role !== 'rider') {
        return res.status(403).send({ message: 'forbidden access' })
      }
      next()
    }

    // tracking check
    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split('-').join(' '),
        createAt: new Date()
      }
      const result = await trackingConnection.insertOne(log)
      return result;

    }

    const riderStatusTransitions = {
      'delivery-assigned': ['rider_arriving', 'rider-arriving', 'parcel-delivered', 'delivery-failed'],
      'rider_arriving': ['parcel-delivered', 'delivery-failed'],
      'rider-arriving': ['parcel-delivered', 'delivery-failed']
    }

    // user related api
    app.get('/users', verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText
      const query = {}
      const requestingUser = await userConnection.findOne({ email: req.decoded_email })
      if (requestingUser?.role !== 'admin') {
        query.email = req.decoded_email
      }
      if (searchText) {
        const safeSearchText = escapeSearchText(searchText)
        // query.displayName = {$regex:searchText, $options:'i'}
        query.$or = [
          { displayName: { $regex: safeSearchText, $options: 'i' } },
          { email: { $regex: safeSearchText, $options: 'i' } },
        ]
      }

      const cursor = userConnection.find(query).sort({ createAt: -1 }).limit(2)
      const result = await cursor.toArray()
      res.send(result)
    })

    app.get('/users/:email/role', verifyFBToken, async (req, res) => {
      const email = req.params.email
      if (email !== req.decoded_email) {
        const requestingUser = await userConnection.findOne({ email: req.decoded_email })
        if (requestingUser?.role !== 'admin') {
          return res.status(403).send({ message: 'forbidden access' })
        }
      }
      const query = { email }
      const user = await userConnection.findOne(query)
      res.send({ role: user?.role || 'user' })
    })

    app.post('/users', verifyFBToken, async (req, res) => {
      const user = req.body;
      user.email = req.decoded_email
      user.role = 'user'
      user.createAt = new Date()

      // already user || check social sign in
      const email = user.email
      const userExits = await userConnection.findOne({ email: email })
      if (userExits) {
        return res.send({ message: 'user exits' })
      }

      const result = await userConnection.insertOne(user)
      res.send(result)
    })

    app.patch('/users/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id
      const roleInfo = req.body
      const query = { _id: new ObjectId(id) }
      const updateDoc = {
        $set: {
          role: roleInfo.role
        }
      }
      const result = await userConnection.updateOne(query, updateDoc)
      res.send(result)
    })


    // =======================
    //      GET PARCELS
    // =======================
    app.get('/parcels', verifyFBToken, async (req, res) => {
      const query = {}
      const { email, delivery_status } = req.query

      const requestingUser = await userConnection.findOne({ email: req.decoded_email })
      if (requestingUser?.role !== 'admin') {
        if (email && email !== req.decoded_email) {
          return res.status(403).send({ message: 'forbidden access' })
        }
        query.senderEmail = req.decoded_email
      }

      if (delivery_status) {
        query.delivery_status = delivery_status
      }

      const options = { sort: { createAt: -1 } }
      const result = await parcelConnection.find(query, options).toArray()
      res.send(result)
    })

    app.get('/parcels/rider', verifyFBToken, verifyRider, async (req, res) => {
      const { delivery_status } = req.query
      const query = {}
      query.riderEmail = req.decoded_email
      if (delivery_status !== "parcel-delivered") {
        query.delivery_status =
          //  { $in: [ "delivery-assigned", "rider_arriving"]}
          { $nin: ["parcel-delivered"] }
      }
      else {
        query.delivery_status = delivery_status
      }

      const cursor = parcelConnection.find(query)
      const result = await cursor.toArray()
      res.send(result)
    })


    // Get single parcel
    app.get('/parcels/:id', verifyFBToken, async (req, res) => {
      const id = req.params.id
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: 'invalid parcel id' })
      }
      const requestingUser = await userConnection.findOne({ email: req.decoded_email })
      const query = { _id: new ObjectId(id) }
      if (requestingUser?.role !== 'admin') {
        query.$or = [
          { senderEmail: req.decoded_email },
          { riderEmail: req.decoded_email }
        ]
      }
      const result = await parcelConnection.findOne(query)
      if (!result) {
        return res.status(404).send({ message: 'parcel not found' })
      }
      res.send(result)
    })

    app.get('/parcels/delivery-status/stats', verifyFBToken, verifyAdmin, async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$delivery_status",
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            status: '$_id',
            count: 1
          }
        }
      ]
      const result = await parcelConnection.aggregate(pipeline).toArray()
      res.send(result)
    })

    // Add parcel
    app.post('/parcels', verifyFBToken, async (req, res) => {
      const parcel = req.body
      const trackingId = generateTrackingId()
      parcel.createAt = new Date()
      parcel.senderEmail = req.decoded_email

      parcel.trackingId = trackingId
      logTracking(trackingId, 'parcel_created')
      const result = await parcelConnection.insertOne(parcel)
      res.send(result)
    })


    app.patch('/parcels/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const { riderId, riderName, riderEmail, trackingId } = req.body
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const updateDoc = {
        $set: {
          delivery_status: 'delivery-assigned',
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail
        }
      }
      const result = await parcelConnection.updateOne(query, updateDoc)

      // update rider info
      const riderQuery = { _id: new ObjectId(riderId) }
      const RiderUpdatedDoc = {
        $set: {
          workStatus: 'in-delivery'
        }
      }
      const riderResult = await riderConnection.updateOne(riderQuery, RiderUpdatedDoc)

      // log tracking
      logTracking(trackingId, "delivery-assigned")
      res.send(riderResult)
    })



    // accept delivery
    app.patch('/parcels/:id/status', verifyFBToken, verifyRider, async (req, res) => {
      const { delivery_status } = req.body;
      if (!ObjectId.isValid(req.params.id) || typeof delivery_status !== 'string') {
        return res.status(400).send({ message: 'invalid parcel status request' })
      }
      const query = {
        _id: new ObjectId(req.params.id),
        riderEmail: req.decoded_email
      };
      const parcel = await parcelConnection.findOne(query)
      if (!parcel) {
        return res.status(404).send({ message: 'assigned parcel not found' })
      }
      const nextStatuses = riderStatusTransitions[parcel.delivery_status] || []
      if (!nextStatuses.includes(delivery_status)) {
        return res.status(409).send({ message: 'invalid parcel status transition' })
      }

      let rider
      if (delivery_status === 'parcel-delivered') {
        rider = await riderConnection.findOne({ email: req.decoded_email })
        if (!rider) {
          return res.status(403).send({ message: 'rider profile not found' })
        }
      }

      const updateQuery = { ...query, delivery_status: parcel.delivery_status }
      const updatedDoc = { $set: { delivery_status } };
      const result = await parcelConnection.updateOne(updateQuery, updatedDoc)
      if (result.matchedCount === 0) {
        return res.status(409).send({ message: 'parcel assignment changed' })
      }

      if (delivery_status === 'parcel-delivered') {
        const riderQuery = { _id: rider._id };
        const RiderUpdatedDoc = { $set: { workStatus: 'available' } };
        await riderConnection.updateOne(riderQuery, RiderUpdatedDoc);
      }

      await logTracking(parcel.trackingId, delivery_status);
      res.send(result);
    });



    // Delete parcel
    app.delete('/parcels/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await parcelConnection.deleteOne(query)
      res.send(result)
    })



    // ==============================
    //      CREATE CHECKOUT SESSION
    // ==============================
    app.post('/create-checkout-session', verifyFBToken, async (req, res) => {
      const paymentInfo = req.body
      if (!ObjectId.isValid(paymentInfo.parcelId)) {
        return res.status(400).send({ message: 'invalid parcel id' })
      }

      const parcel = await parcelConnection.findOne({ _id: new ObjectId(paymentInfo.parcelId) })
      if (!parcel) {
        return res.status(404).send({ message: 'parcel not found' })
      }
      if (parcel.senderEmail !== req.decoded_email) {
        return res.status(403).send({ message: 'forbidden access' })
      }

      const amount = Math.round(Number(parcel.cost) * 100)
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return res.status(400).send({ message: 'parcel has an invalid delivery cost' })
      }
      const parcelName = parcel.parcelName || parcel.name || 'Parcel delivery'

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              unit_amount: amount,
              product_data: {
                name: parcelName
              }
            },
            quantity: 1,
          },
        ],

        // Stripe will email receipt
        customer_email: req.decoded_email,
        mode: 'payment',

        // ✅ FIXED: metadata MUST BE AT ROOT LEVEL
        metadata: {
          parcelId: parcel._id.toString(),
          parcelName,
          trackingId: parcel.trackingId

        },

        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
      })

      res.send({ url: session.url })
    })

    // ============================
    //       PAYMENT SUCCESS
    // ============================
    app.patch('/payment-success', async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(session)

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId }
      const paymentExist = await paymentConnection.findOne(query)
      if (paymentExist) {
        return res.send({
          message: 'already exit',
          transactionId: transactionId,
          trackingId: paymentExist.trackingId
        })
      }

      // previous trackingId
      const trackingId = session.metadata.trackingId

      if (session.payment_status === 'paid') {
        const id = session.metadata.parcelId;

        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            payment_status: "paid",
            delivery_status: "pending-pickup",
            paymentDate: new Date(),
            trackingId: trackingId,
            transactionId: transactionId
          }
        };

        const result = await parcelConnection.updateOne(query, update);
        const payment = {
          amount: session.amount_total,
          currency: session.currency,
          customer_email: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId
        }

        if (session.payment_status === 'paid') {
          const paymentResult = await paymentConnection.insertOne(payment)
          logTracking(trackingId, "pending-pickup")
          return res.send({
            success: true,
            modifyParcel: result,
            paymentInfo: paymentResult,
            trackingId: trackingId,
            transactionId: transactionId
          })
        }
      }
      return res.send({ success: false })
    });


    //  payment related apl
    app.get('/payments', verifyFBToken, async (req, res) => {
      const email = req.query.email
      const query = {}
      const requestingUser = await userConnection.findOne({ email: req.decoded_email })
      if (requestingUser?.role !== 'admin') {
        if (email && email !== req.decoded_email) {
          return res.status(403).send({ message: 'forbidden access' })
        }
        query.customer_email = req.decoded_email
      } else if (email) {
        query.customer_email = email
      }
      const cursor = paymentConnection.find(query).sort({ paidAt: -1 })
      const result = await cursor.toArray()
      res.send(result)
    })


    // rider related api
    app.get('/riders', verifyFBToken, verifyAdmin, async (req, res) => {
      const { status, district, workStatus } = req.query
      const query = {}
      if (status) {
        query.status = status
      }
      if (district) {
        query.senderDistrict = district
      }
      if (workStatus) {
        query.workStatus = workStatus
      }
      const cursor = riderConnection.find(query)
      const result = await cursor.toArray()
      res.send(result)
    })

    // app.get('/riders/delivery-per-day', async (req, res) => {
    //   const email = req.query.email
    //   // rider aggregate
    //   const pipeline = [
    //     {
    //       $match: {
    //         riderEmail: email,
    //         delivery_status: "parcel-delivered"
    //       }
    //     },
    //     {
    //       $lookup: {
    //         from: 'tracking',
    //         localField: 'trackingId',
    //         foreignField: 'trackingId',
            
    //       }
    //     }

    //   ]
    //   const result = await parcelConnection.aggregate(pipeline).toArray()
    //   res.send(result)
    // })

    app.post('/riders', verifyFBToken, async (req, res) => {
      const rider = req.body
      rider.email = req.decoded_email
      rider.status = 'pending'
      rider.createAt = new Date()

      const result = await riderConnection.insertOne(rider)
      res.send(result)
    })

    app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const updatedDoc = {
        $set: {
          status: status,
          workStatus: 'available'
        }
      }
      const result = await riderConnection.updateOne(query, updatedDoc)

      if (status === 'approved') {
        const email = req.body.email
        // console.log('', )
        const updateQuery = { email }
        const updateUser = {
          $set: {
            role: 'rider'
          }
        }
        const userResult = await userConnection.updateOne(updateQuery, updateUser)

      }
      res.send(result);
    })


    // delete riders
    app.delete('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id
      const result = await riderConnection.deleteOne({ _id: new ObjectId(id) })
      res.send(result)

    })

    // tracking related api
    app.get('/tracking/:trackingId/logs', trackingRateLimit, async (req, res) => {
      const trackingId = req.params.trackingId
      if (!isValidTrackingNumber(trackingId)) {
        return res.status(400).send({ message: 'invalid tracking number' })
      }
      const query = { trackingId }
      const result = await trackingConnection.find(query, {
        projection: {
          _id: 0,
          trackingId: 1,
          status: 1,
          details: 1,
          createAt: 1
        }
      }).toArray()
      res.send(result)
    })

    app.use((req, res) => {
      res.status(404).send({ message: 'route not found' })
    })

    app.use((err, req, res, next) => {
      const errorStatus = Number.isInteger(err.statusCode) ? err.statusCode : err.status
      const statusCode = Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 600
        ? errorStatus
        : 500

      if (statusCode >= 500) {
        console.error(JSON.stringify({
          level: 'error',
          requestId: req.requestId,
          error: err.message
        }))
      }

      res.status(statusCode).send({
        message: statusCode < 500 ? 'Invalid request' : 'Internal server error',
        requestId: req.requestId
      })
    })

    // await client.db("admin").command({ ping: 1 });
    // console.log("Connected to MongoDB!");
  } finally { }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
