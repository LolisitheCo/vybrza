
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";

export async function syncEmailVerification(req, res) {
  try {
    const uid = req.user?.uid;

    if (!uid) {
      return res.status(401).json({
        success: false,
        message: "Authentication required."
      });
    }

    // Fetch the latest verified status directly from Firebase Auth.
    const firebaseUser = await getAuth().getUser(uid);

    const emailVerified = firebaseUser.emailVerified === true;

    // Update the existing Firestore user document.
    await db.collection("users").doc(uid).set(
      {
        emailVerified,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return res.status(200).json({
      success: true,
      emailVerified,
      message: emailVerified
        ? "Email verification synchronised."
        : "Your email address is not verified yet."
    });

  } catch (error) {
    console.error("Email verification sync failed:", {
      code: error?.code || "UNKNOWN_ERROR"
    });

    return res.status(500).json({
      success: false,
      message: "Unable to synchronise email verification."
    });
  }
}
