
import express from "express";
import cors from "cors";
import "dotenv/config";
import healthRouter from "./routes/health.js";
import scalingRouter from "./routes/scaling.js";
const app = express();

app.use(cors());
app.use(express.json());

app.use("/health", healthRouter);
app.use("/api/scaling", scalingRouter);
const PORT = Number(process.env.PORT ?? 4000);

app.listen(PORT, () => {
  console.log(`AutoScale controller running on port ${PORT}`);
});
