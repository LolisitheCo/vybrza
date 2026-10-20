
import { getAuth } from "firebase-admin/auth";
import { db } from "../config/firebase.js";

export async function verifyFirebaseToken(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    const [scheme, token] = authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const decodedToken = await getAuth().verifyIdToken(token);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
    };

    next();
  } catch (error) {
    console.error("Authentication failed:", error.message);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token.",
    });
  }
}

export async function requireAdmin(req, res, next) {
  try {
    if (!req.user?.uid) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const adminDoc = await db
      .collection("admins")
      .doc(req.user.uid)
      .get();

    if (!adminDoc.exists || adminDoc.data()?.active !== true) {
      return res.status(403).json({
        success: false,
        message: "Administrator access denied.",
      });
    }

    req.admin = {
      uid: req.user.uid,
    };

    next();
  } catch (error) {
    console.error("Admin authorization failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify administrator access.",
    });
  }
}

export async function requireHost(req, res, next) {
  try {
    if (!req.user?.uid) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const snapshot = await db
      .collection("hosts")
      .where("firebaseUid", "==", req.user.uid)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(403).json({
        success: false,
        message: "No host account is linked to this user.",
      });
    }

    const doc = snapshot.docs[0];
    const host = { id: doc.id, ...doc.data() };

    if (host.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Your host account is not active.",
      });
    }

    req.host = host;
    next();
  } catch (error) {
    console.error("Host authorization failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to verify host access.",
    });
  }
}