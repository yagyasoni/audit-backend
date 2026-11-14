import { randomInt } from "crypto";

function generateOTP() {
  return randomInt(100000, 1000000).toString();
}

export default generateOTP;
