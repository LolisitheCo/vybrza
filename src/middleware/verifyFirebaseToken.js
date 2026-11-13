
import { getAuth } from "firebase-admin/auth";
import { firebaseApp } from "../config/firebase.js";

const firebaseAuth = getAuth(firebaseApp);

export async function verifyFirebaseToken(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication token is missing.",
      });
    }

    const decodedToken = await firebaseAuth.verifyIdToken(token);

    req.user = decodedToken;

    return next();
  } catch (error) {
    console.error(
      "Firebase token verification failed:",
      error.message
    );

    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token.",
    });
  }
}
