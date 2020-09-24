import * as cdk from '@aws-cdk/core';
import {Duration, Tags} from '@aws-cdk/core';
import {Port, Vpc} from "@aws-cdk/aws-ec2";
import * as ssm from '@aws-cdk/aws-ssm'
import * as ecs from '@aws-cdk/aws-ecs';
import {CfnService, FargatePlatformVersion, NetworkMode} from '@aws-cdk/aws-ecs';
import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';
import * as acm from '@aws-cdk/aws-certificatemanager';
import * as route53 from '@aws-cdk/aws-route53';
import * as efs from '@aws-cdk/aws-efs';
import {AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId,} from "@aws-cdk/custom-resources";

export class BenkhardJenkinsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = Vpc.fromLookup(this, 'DefaultVPC', {isDefault: true});
    const cluster = new ecs.Cluster(this, 'PlatformCluster', {
      vpc,
      clusterName: 'jenkins-cluster'
    });

    new ssm.StringParameter(this, 'PlatformClusterArnSSMParameter', {
      parameterName: '/com/benkhard/platform-cluster-arn',
      description: 'The arn of the Platform ECS cluster.',
      stringValue: cluster.clusterArn
    });

    new ssm.StringParameter(this, 'PlatformClusterNameSSMParameter', {
      parameterName: '/com/benkhard/platform-cluster-name',
      description: 'The name of the Platform ECS cluster.',
      stringValue: cluster.clusterName
    });

    const certificateArn = ssm.StringParameter.valueFromLookup(this, '/com/benkhard/wildcard-certificate')
    const certificate = acm.Certificate.fromCertificateArn(this, 'WildcardCertificate', certificateArn);

    const hostedZoneId = ssm.StringParameter.valueFromLookup(this, '/com/benkhard/public-hosted-zone-id');
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicHostedZone', { hostedZoneId: hostedZoneId, zoneName: 'benkhard.com' });

    const fileSystem = new efs.FileSystem(this, 'JenkinsEfsFileSystem', {
      vpc,
      fileSystemName: 'jenkins-fs',
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    });

    const accessPoint = fileSystem.addAccessPoint('JenkinsAccessPoint', {
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '777'
      },
      path: '/jenkins',
      posixUser: {
        gid: '1000',
        uid: '1000'
      }
    })

    const efsVolume: ecs.Volume = {
      name: 'efs',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        rootDirectory: "/",
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId
        }
      }
    };

    const jenkinsEfsMountPoint: ecs.MountPoint = {
      containerPath: "/var/jenkins_home",
      sourceVolume: efsVolume.name,
      readOnly: false,
    }

    const image = 'jenkins/jenkins';
    const cpu = 256;
    const memoryLimit = 1024;
    const containerPort = 8080;

    const loadBalancerFargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "JenkinsService", {
      cluster: cluster, // Required
      platformVersion: FargatePlatformVersion.VERSION1_4,
      cpu: cpu, // Default is 256
      desiredCount: 1, // Default is 1
      taskImageOptions: { image: ecs.ContainerImage.fromRegistry(image), containerPort: containerPort },
      memoryLimitMiB: memoryLimit, // Default is 512
      publicLoadBalancer: true, // Default is false
      assignPublicIp: true,
      certificate: certificate,
      healthCheckGracePeriod: Duration.minutes(5),
      domainName: 'jenkins.benkhard.com',
      domainZone: hostedZone,
    });

    const customTaskDefinitionJson = {
      containerDefinitions: [
        {
          essential: true,
          image: image,
          logConfiguration: {
            logDriver:
            loadBalancerFargateService.taskDefinition.defaultContainer?.logDriverConfig
                ?.logDriver,
            options:
            loadBalancerFargateService.taskDefinition.defaultContainer?.logDriverConfig
                ?.options,
          },
          memory: memoryLimit,
          mountPoints: [jenkinsEfsMountPoint],
          name: loadBalancerFargateService.taskDefinition.defaultContainer?.containerName,
          portMappings: [
            {
              containerPort: containerPort,
              protocol: "tcp",
            },
          ],
        },
      ],
      cpu: cpu,
      executionRoleArn: loadBalancerFargateService.taskDefinition.executionRole?.roleArn,
      family: loadBalancerFargateService.taskDefinition.family,
      memory: memoryLimit,
      networkMode: NetworkMode.AWS_VPC,
      requiresCompatibilities: ["FARGATE"],
      taskRoleArn: loadBalancerFargateService.taskDefinition.taskRole.roleArn,
      volumes: [efsVolume],
    };

    const createOrUpdateCustomTaskDefinition = {
      service: "ECS",
      action: "registerTaskDefinition",
      outputPath: "taskDefinition.taskDefinitionArn",
      parameters: customTaskDefinitionJson,
      physicalResourceId: PhysicalResourceId.fromResponse(
          "taskDefinition.taskDefinitionArn"
      ),
    };

    const customTaskDefinition = new AwsCustomResource(
        loadBalancerFargateService,
        "CustomFargateTaskDefinition",
        {
          onCreate: createOrUpdateCustomTaskDefinition,
          onUpdate: createOrUpdateCustomTaskDefinition,
          policy: AwsCustomResourcePolicy.fromSdkCalls({
            resources: AwsCustomResourcePolicy.ANY_RESOURCE,
          }),
        },
    );

    Tags.of(customTaskDefinition).add('service', 'jenkins')

    loadBalancerFargateService.taskDefinition.executionRole?.grantPassRole(
        customTaskDefinition.grantPrincipal
    );
    loadBalancerFargateService.taskDefinition.taskRole.grantPassRole(
        customTaskDefinition.grantPrincipal
    );

    // Need to add permissions to and from the file system to the target,
    // or else the task will timeout trying to mount the file system.
    loadBalancerFargateService.service.connections.allowFrom(fileSystem, Port.tcp(2049));
    loadBalancerFargateService.service.connections.allowTo(fileSystem, Port.tcp(2049));

    /*
      After creating the task definition custom resouce, update the
      fargate service to use the new task definition revision above.
      This will get around the current limitation of not being able to create
      ecs services with task definition arns.
    */
    (loadBalancerFargateService.service.node.tryFindChild(
        "Service"
    ) as CfnService)?.addPropertyOverride(
        "TaskDefinition",
        customTaskDefinition.getResponseField("taskDefinition.taskDefinitionArn")
    );

    loadBalancerFargateService.targetGroup.configureHealthCheck({
      path: '/login'
    });
  }
}
