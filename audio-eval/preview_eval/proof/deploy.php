#!/usr/bin/php
<?PHP
// Create or update the kestrel-audio container the way the Docker tab's "Apply Update" does (skill://unraid-container-deploy):
// stop if running, CreateDocker.php in updateContainer mode (pulls :latest, re-creates from the user template), start.
// Usage on Unraid: php /tmp/ka-deploy.php
$docroot = '/usr/local/emhttp';
$_SERVER['DOCUMENT_ROOT'] = $docroot;
require_once("$docroot/plugins/dynamix.docker.manager/include/DockerClient.php");
$name = 'kestrel-audio';
$DockerClient = new DockerClient();
$DockerTemplates = new DockerTemplates();
$wasRunning = false;
foreach ($DockerClient->getDockerContainers() as $c)
  if ($c['Name'] === $name) $wasRunning = (bool)$c['Running'];
if ($wasRunning) exec("docker stop -t 20 " . escapeshellarg($name));
$_GET['updateContainer'] = true;
$_GET['ct'] = array($name);
include("$docroot/plugins/dynamix.docker.manager/include/CreateDocker.php");
// a brand-new container is created stopped: start it (an updated one is started again too)
exec("docker start " . escapeshellarg($name) . " 2>&1", $out, $rc);
echo "\nstart rc=$rc " . implode(' ', $out) . "\n";
