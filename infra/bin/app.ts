#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UrlShortenerStack } from '../lib/url-shortener-stack';

const app = new cdk.App();

new UrlShortenerStack(app, 'UrlShortenerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
