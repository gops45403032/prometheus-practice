import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface PipelineStackProps extends cdk.StackProps {
  cluster: ecs.Cluster;
  service: ecs.FargateService;
}

/**
 * A minimal, real CI/CD pipeline: push to GitHub -> CodePipeline picks it up
 * -> CodeBuild builds the Docker image in /app, pushes it to ECR, registers
 * a new ECS task definition revision pointing at that image, and updates
 * the running service to use it.
 *
 * Requires a one-time manual step you do in the console before deploying
 * this stack: create a CodeStar Connection to GitHub and authorize it.
 * That connection's ARN gets passed in as a context value -- see README.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const githubConnectionArn = this.node.tryGetContext('githubConnectionArn');
    const githubOwner = this.node.tryGetContext('githubOwner');
    const githubRepo = this.node.tryGetContext('githubRepo');
    const githubBranch = this.node.tryGetContext('githubBranch') ?? 'main';

    if (!githubConnectionArn || !githubOwner || !githubRepo) {
      throw new Error(
        'Pass --context githubConnectionArn=... --context githubOwner=... --context githubRepo=... when deploying PipelineStack.'
      );
    }

    // ---- ECR: where built images live -----------------------------------
    const repo = new ecr.Repository(this, 'AppRepo', {
      repositoryName: 'prometheus-practice-app',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteImages: true, // so `cdk destroy` doesn't get blocked by leftover images
      imageScanOnPush: true,
    });

    // ---- CodeBuild: build, push, deploy -----------------------------------
    const project = new codebuild.PipelineProject(this, 'BuildProject', {
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // required to run `docker build` inside CodeBuild
      },
      environmentVariables: {
        ECR_REPO_URI: { value: repo.repositoryUri },
        CLUSTER_NAME: { value: props.cluster.clusterName },
        SERVICE_NAME: { value: props.service.serviceName },
        CONTAINER_NAME: { value: 'AppContainer' },
      },
    });

    repo.grantPullPush(project);

    // Deploy step in the buildspec needs permission to update the service
    // and register new task definition revisions -- least privilege, not "*".
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeServices', 'ecs:UpdateService', 'ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition'],
        resources: ['*'], // ECS task-def/service actions don't support fine-grained resource ARNs for these calls
      })
    );
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.service.taskDefinition.executionRole!.roleArn, props.service.taskDefinition.taskRole.roleArn],
      })
    );

    // ---- Pipeline: Source (GitHub) -> Build (CodeBuild) -------------------
    const sourceOutput = new codepipeline.Artifact('Source');

    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'prometheus-practice-pipeline',
      stages: [
        {
          stageName: 'Source',
          actions: [
            new actions.CodeStarConnectionsSourceAction({
              actionName: 'GitHub',
              owner: githubOwner,
              repo: githubRepo,
              branch: githubBranch,
              connectionArn: githubConnectionArn,
              output: sourceOutput,
            }),
          ],
        },
        {
          stageName: 'BuildAndDeploy',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'BuildAndDeploy',
              project,
              input: sourceOutput,
            }),
          ],
        },
      ],
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', { value: repo.repositoryUri });
  }
}
