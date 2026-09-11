#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PrometheusCdkStack } from '../lib/prometheus-cdk-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

const mainStack = new PrometheusCdkStack(app, 'PrometheusCdkStack', {
  description:
    'Prometheus Group take-home, practice build: HA 2-AZ web app on ECS Fargate + ALB + RDS, sized for the AWS Free Tier.',
});

// Only synthesized when you explicitly `cdk deploy PipelineStack` with the
// required --context values -- see README for the CodeStar Connection setup.
new PipelineStack(app, 'PipelineStack', {
  cluster: mainStack.cluster,
  service: mainStack.service,
  description: 'CI/CD: GitHub -> CodePipeline -> CodeBuild -> ECR -> ECS deploy',
});
