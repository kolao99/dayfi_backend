import { db } from '../../config/database';
import { authQueries } from '../../modules/authentication/query';
import { paymentQueries } from '../../modules/payment/query';
import { ITask } from 'pg-promise';

export interface QueryPayload {
  query: string;
  payload: any[];
}

interface QueryMap {
  [key: string]: string;
}

interface Queries {
  [key: string]: QueryMap;
}

export interface QueryItem {
  query: string;
  payload: Record<string, any>;
}

class DBService {
  nestedTransaction = (data: QueryItem[]): Promise<any[]> => {
    return db.tx((t: ITask<any>) => {
      const sqlParam: Promise<any>[] = [];
      data.forEach((item: QueryItem) => {
        sqlParam.push(t.any(item.query, item.payload));
      });
      return t.batch(sqlParam);
    });
  };

  transact = <T>(query: string, data: any[], type: string) =>
    db.any<T>(queries[type][query], data);

  singleTransaction = <T>(query: string, data: any[], type: string) =>
    db.oneOrNone<T>(queries[type][query], data);

  noReturnTransaction = (query: string, data: any[], type: string) =>
    db.none(queries[type][query], data);

  multipleTransaction = async (transactions: any[][]) => {
    const result = await db.tx((t) =>
      t.batch(transactions.map((transaction) => t.batch(transaction)))
    );
    return result;
  };
}

export const queries: Queries = {
  authQueries,
  paymentQueries,
};

export default DBService;
