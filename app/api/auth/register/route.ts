import { apiSuccess, handleApiError } from "@/shared/api/response";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";

/**
 * Registration status probe used by the register/login pages to decide whether
 * to show the sign-up form. Account creation itself goes through the verified
 * email flow at POST /api/auth/register-email → OTP → /api/auth/verify-otp;
 * there is deliberately NO unverified POST here (that would let anyone create an
 * active account without proving they control an email address).
 */
export async function GET() {
  try {
    const settings = await getAdminSettings();
    return apiSuccess({
      enabled: settings.registrationEnabled,
      maintenance: settings.maintenanceMode,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
