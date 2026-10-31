import express from "express"
import cors from "cors"
import { MongoClient } from 'mongodb';
import "dotenv/config"

const PORT = 5000;

const app = express();
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
const facilitiesCollection = db.collection("facilities")

app.post("facilities", async (req,res)=>{
    // Step-1: Retrive the data form the request body
    const facilityData = req.body;
    const result = await facilitiesCollection.insertOne(facilityData)
    result = res.send(result)
})

app.get("/facilities", async (req, res)=>{
    const result = await facilitiesCollection.find().toArray();
    res.send(result)

})

app.get("/", (req, res)=>{
    res.send("Hello World!")
})

app.listen(PORT, ()=> {
    console.log(`Server is eunning on port ${PORT}`)
})