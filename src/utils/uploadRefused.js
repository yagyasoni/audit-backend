// An upload the user has to correct (unreadable file, wrong columns, dates
// that do not exist). The message is written for the user and is safe to
// show. Anything else that goes wrong during an upload is a server problem:
// it is logged, and the user gets a plain "could not be saved" message with
// no server details.
export class UploadRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadRefused";
    this.status = 400;
    this.expose = true;
  }
}
