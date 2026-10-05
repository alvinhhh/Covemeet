export { loadMailConfig, hasMail, mailbox, type MailConfig } from "./config.js";
export {
  createMailTransport,
  type MailTransport,
  type MailBudget,
} from "./transport.js";
export { createMailBudget } from "./budget.js";
