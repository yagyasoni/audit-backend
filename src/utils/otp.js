<<<<<<< HEAD
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
=======
import { randomInt } from "crypto";

function generateOTP() {
  return randomInt(100000, 1000000).toString();
>>>>>>> 4fc9c18 (Fix all medium and low priority bugs from audit PDFs)
}

export default generateOTP;
