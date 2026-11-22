import express from "express";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";
import { registerCustomer } from "../controllers/authController.js";

const router = express.Router();

// Firebase Authentication proves the account identity. The backend
// validates the age declaration before creating the customer profile.
router.post("/register-customer", verifyFirebaseToken, registerCustomer);

export default router;
