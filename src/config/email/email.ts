import { welcomeUserEmail } from './templates/welcomeUser';

interface CommonTemplateData {
  firstName: string;
  lastName: string;
  email?: string;
  role?: string;
  userOtp?: string;
  name: string;
  url: string;
  eventName: string;
  ticketName: string;
  eventDate: string;
  eventTime: string;
  eventAddress: string;
  eventType: string;
  ticketAmount: string;
  eventSlug: string;
}

export const commonTemplate = (
  messageType: string,
  data: CommonTemplateData
): string => {
  switch (messageType) {
    case 'welcomeUserEmail':
      return welcomeUserEmail(data.firstName, String(data.userOtp));
    default:
      return '';
  }
};
