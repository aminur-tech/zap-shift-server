const express = require('express')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors')
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
const serviceAccount = require('./zab-shift-firebase-adminsdk-fbsvc-a62efd09f0.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


// middleware
app.use(express.json())
app.use(cors())

const verifyFBToken = async (req, res, next) => {
  // console.log('verify', req.headers.authorization)
  const token = req.headers.authorization
  if (!token) {
    return res.status(401).send({ message: 'unAuthorized access' })
  }
  try {
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    console.log('decode in the token', decoded)
    req.decoded_email = decoded.email
    next()
  }
  catch (err) {
    return res.status(401).send({ message: 'unauthorized access' })

  }
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.f47fo9z.mongodb.net/?appName=Cluster0`;

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
    await client.connect();

    const db = client.db('Zab-Shift')
    const userConnection = db.collection('users')
    const parcelConnection = db.collection('parcels')
    const paymentConnection = db.collection('payment')
    const riderConnection = db.collection('rider')

    // verify with more database access 
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email
      const query = { email }
      const user = await userConnection.findOne(query)
      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' })
      }
      next()

    }


    // user related api
    app.get('/users', verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText
      const query = {}
      if (searchText) {
        // query.displayName = {$regex:searchText, $options:'i'}
        query.$or = [
          { displayName: { $regex: searchText, $options: 'i' } },
          { email: { $regex: searchText, $options: 'i' } },
        ]
      }

      const cursor = userConnection.find(query).sort({ createAt: -1 }).limit(2)
      const result = await cursor.toArray()
      res.send(result)
    })

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email
      const query = { email }
      const user = await userConnection.findOne(query)
      res.send({ role: user?.role || 'user' })
    })

    app.post('/users', async (req, res) => {
      const user = req.body;
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
    app.get('/parcels', async (req, res) => {
      const query = {}
      const { email, delivery_status } = req.query

      if (email) {
        query.senderEmail = email
      }

      if (delivery_status) {
        query.delivery_status = delivery_status
      }

      const options = { sort: { createAt: -1 } }
      const result = await parcelConnection.find(query, options).toArray()
      res.send(result)
    })

    // Get single parcel
    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await parcelConnection.findOne(query)
      res.send(result)
    })

    // Add parcel
    app.post('/parcels', async (req, res) => {
      const parcel = req.body
      parcel.createAt = new Date()
      const result = await parcelConnection.insertOne(parcel)
      res.send(result)
    })

    // Delete parcel
    app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await parcelConnection.deleteOne(query)
      res.send(result)
    })



    // ==============================
    //      CREATE CHECKOUT SESSION
    // ==============================
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      const amount = parseInt(paymentInfo.cost) * 100

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName
              }
            },
            quantity: 1,
          },
        ],

        // Stripe will email receipt
        customer_email: paymentInfo.senderEmail,
        mode: 'payment',

        // ✅ FIXED: metadata MUST BE AT ROOT LEVEL
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName
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


      const trackingId = generateTrackingId()

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
          res.send({
            success: true,
            modifyParcel: result,
            paymentInfo: paymentResult,
            trackingId: trackingId,
            transactionId: transactionId
          })
        }
      }
      res.send({ success: false })
    });


    //  payment related apl
    app.get('/payments', verifyFBToken, async (req, res) => {
      const email = req.query.email
      // console.log('headers', req.headers)
      const query = {}
      if (email) {
        query.customer_email = email
        // check valid email
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: 'forbidden access' })
        }
      }
      const cursor = paymentConnection.find(query).sort({ paidAt: -1 })
      const result = await cursor.toArray()
      res.send(result)
    })


    // rider related api
    app.get('/riders', async (req, res) => {
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

    app.post('/riders', async (req, res) => {
      const rider = req.body
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

    app.patch('/parcels/:id', async (req, res) => {
      const { riderId, riderName, riderEmail } = req.body
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
      res.send(riderResult)
    })


    // delete riders
    app.delete('/riders/:id', async (req, res) => {
      const id = req.params.id
      const result = await riderConnection.deleteOne({ _id: new ObjectId(id) })
      res.send(result)

    })





    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally { }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
