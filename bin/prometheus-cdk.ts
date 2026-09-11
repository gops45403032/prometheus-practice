#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PrometheusCdkStack } from '../lib/prometheus-cdk-stack';

const app = new cdk.App();

new PrometheusCdkStack(app, 'PrometheusCdkStack', {
  /* Uses whatever account/region your AWS CLI profile is configured for.
     Pin it explicitly if you want to be sure:
  env: { account: '123456789012', region: 'eu-west-1' },
  */
  description:
    'Prometheus Group take-home, practice build: HA 2-AZ web app on ECS-alternative EC2 ASG + ALB + RDS, sized for the AWS Free Tier.',
});
