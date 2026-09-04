import {
  getUserById,
  resolveOrCreateUserByPhone,
  touchLastSeen,
  updateProfile,
  type FourUser,
} from '../auth/identityService';
import {
  getLinkByWhatsappPhone,
  linkWhatsappUser,
  type FourWhatsappLink,
} from './whatsappLinkService';

export type WhatsappIdentityInput = {
  phoneE164: string;
  profileName?: string;
};

export type WhatsappSession = {
  user: FourUser;
  link: FourWhatsappLink;
  isNewUser: boolean;
};

/**
 * WhatsApp is a front door. The user's WhatsApp phone establishes identity;
 * we reuse or create the Dayfi user via the existing phone identity service.
 */
export async function resolveWhatsappSession(
  input: WhatsappIdentityInput
): Promise<WhatsappSession> {
  const existingLink = await getLinkByWhatsappPhone(input.phoneE164);
  if (existingLink) {
    const user = await getUserById(existingLink.user_id);
    if (!user) {
      throw new Error('WhatsApp link points to a missing user.');
    }
    await touchLastSeen(user.user_id);
    return { user, link: existingLink, isNewUser: false };
  }

  const { user, isNewUser } = await resolveOrCreateUserByPhone(input.phoneE164);

  const profileName = String(input.profileName || '').trim();
  if (isNewUser && profileName) {
    const parts = profileName.split(/\s+/);
    const firstName = parts[0] || 'Friend';
    const lastName = parts.slice(1).join(' ') || null;
    await updateProfile(user.user_id, {
      firstName,
      lastName: lastName ?? undefined,
    });
    const refreshed = await getUserById(user.user_id);
    if (refreshed) {
      Object.assign(user, refreshed);
    }
  }

  const link = await linkWhatsappUser({
    userId: user.user_id,
    phoneE164: input.phoneE164,
    displayName: profileName || null,
  });

  return { user, link, isNewUser };
}
