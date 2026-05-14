import { Request, Response, NextFunction } from 'express';

export type ExpressController = (
  req: Request,
  res: Response,
  next?: NextFunction
) => any;

export type fnRequest = (req: Request, res: Response) => Promise<any>;
