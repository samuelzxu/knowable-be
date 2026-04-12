/**
 * Authorizer stub — actual JWT authorization is handled by the API Gateway
 * HTTP JWT authorizer configured in Terraform (apigw_http.tf).
 *
 * This file exports the verifier singleton for Terraform reference and
 * any Lambda@Edge or custom authorizer use in the future.
 */
export { getJwtVerifier } from "../lib/auth.js";
