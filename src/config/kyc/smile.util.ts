// import axios from 'axios';
// import crypto from 'crypto';
// import config from '../env';
//
// interface SmileJobRequest {
//   jobType: number;
//   userId: string;
//   idType?: string;
//   idNumber?: string;
//   firstName?: string;
//   lastName?: string;
//   dob?: string;
//   phoneNumber?: string;
//   image?: string;
//   country?: string;
// }
//
// export default class SmileUtil {
//   private partnerId: string;
//   private apiKey: string;
//   private callbackUrl?: string;
//   private baseUrl: string;
//
//   constructor() {
//     this.partnerId = config?.SMILE_PARTNER_ID as string;
//     this.apiKey = config?.SMILE_API_KEY as string;
//     this.callbackUrl = config?.SMILE_CALLBACK_URL as string;
//     this.baseUrl = config?.SMILE_BASE_URL as string;
//   }
//
//   /**
//    * Generate Smile Identity Signature
//    */
//   private generateSignature(timestamp: string): string {
//     const message = `${this.partnerId}:${timestamp}`;
//     return crypto
//       .createHmac('sha256', this.apiKey)
//       .update(message)
//       .digest('hex');
//   }
//
//   /**
//    * Create a verification job
//    */
//   async createJob(jobRequest: SmileJobRequest): Promise<any> {
//     const timestamp = new Date().toISOString();
//     const signature = this.generateSignature(timestamp);
//
//     const payload = {
//       partner_id: this.partnerId,
//       timestamp,
//       signature,
//       job_type: jobRequest.jobType,
//       callback_url: this.callbackUrl,
//       user_id: jobRequest.userId,
//       partner_params: {
//         user_id: jobRequest.userId,
//         job_type: jobRequest.jobType,
//       },
//       id_info: {
//         id_type: jobRequest.idType,
//         id_number: jobRequest.idNumber,
//         country: jobRequest.country || 'NG',
//         first_name: jobRequest.firstName,
//         last_name: jobRequest.lastName,
//         dob: jobRequest.dob,
//         phone_number: jobRequest.phoneNumber,
//       },
//       images: jobRequest.image
//         ? [
//             {
//               image_type_id: 'selfie',
//               image: jobRequest.image,
//             },
//           ]
//         : [],
//     };
//
//     try {
//       const response = await axios.post(`${this.baseUrl}/job`, payload, {
//         headers: { 'Content-Type': 'application/json' },
//       });
//
//       return response.data;
//     } catch (error: any) {
//       console.error(
//         'Smile Identity API error:',
//         error.response?.data || error.message
//       );
//       throw new Error(
//         error.response?.data?.message || 'Smile Identity job creation failed'
//       );
//     }
//   }
//
//   /**
//    * Verify a job result (optional)
//    */
//   async getJobResult(jobId: string): Promise<any> {
//     const timestamp = new Date().toISOString();
//     const signature = this.generateSignature(timestamp);
//
//     try {
//       const response = await axios.post(
//         `${this.baseUrl}/job_status`,
//         {
//           partner_id: this.partnerId,
//           timestamp,
//           signature,
//           job_id: jobId,
//         },
//         { headers: { 'Content-Type': 'application/json' } }
//       );
//
//       return response.data;
//     } catch (error: any) {
//       console.error(
//         'Smile Identity status error:',
//         error.response?.data || error.message
//       );
//       throw new Error(
//         error.response?.data?.message || 'Failed to fetch job status'
//       );
//     }
//   }
// }
