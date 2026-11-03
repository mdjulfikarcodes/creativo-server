import express from "express"
import cors from "cors"
import { MongoClient } from 'mongodb';
import "dotenv/config"

const PORT = 5000;

const app = express();
app.use(cors(["http://localhost:3000"]));
app.use(express.json());




const client = new MongoClient(process.env.MONGO_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
const connectedClient = await connectToMongoDB()
const db = connectedClient.db("creativo");
const studiosCollection = db.collection("studio")
const studiosBookingCollection = db.collection("studio")

app.post("/studio", async (req,res)=>{
    // Step-1: Retrive the data form the request body
    const facilityData = req.body;

    //Step-2: Insert The data into the mongodb collection
    const result = await studiosCollection.insertOne(facilityData)
    res.send(result)
})

app.get("/studio", async (req, res)=>{
    const result = await studiosCollection.find().toArray();
    res.send(result)
})

app.get("/studio/:id", async (req, res)=>{
    const id = req.params.id;
    const result = await studiosCollection.findOne({id: id});
    res.send(result)
})

app.post("/studio/booking", async (req, res)=>{
  const bookingData = req.body;
  console.log(req.body, "booking data")
  const result = await studiosBookingCollection.insertOne(bookingData);
  res.send(result);
})

app.get("/", (req, res)=>{
    res.send("Hello World!")
})

app.listen(PORT, ()=> {
    console.log(`Server is eunning on port ${PORT}`)
})