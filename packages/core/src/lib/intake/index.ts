/*
  The parts of the intake that do not touch the database or object storage,
  so a browser bundle can import them safely.

  service.ts and storage.ts are separate entry points precisely because they
  do touch both.
*/
export * from "./schema";
export * from "./completeness";
export * from "./project-type";
export * from "./gate";
export * from "./tier";
export * from "./fit";
export * from "./integrations";
export * from "./files";
export * from "./sections";
export * from "./prefill-fields";
export * from "./service-area";
export * from "./palette";
export * from "./service-suggestions";
// The phone check the form shows beside the field (F-035); pure, so safe in a browser bundle.
export { formatUsPhone, phoneProblem } from "../phone";
